import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JobRegistry, formatCompletion, isValidJobId, type JobRecord } from "../src/plugins/shell/registry.js";
import { spawn } from "child_process";
import { MessageQueue } from "../src/queue.js";

const origin = { interface: "slack", channel: "#builds", chatId: "C123", userId: "U1" };

function setup() {
  const agentDir = mkdtempSync(join(tmpdir(), "kern-jobs-"));
  const registry = new JobRegistry(agentDir);
  const announced: { record: JobRecord; body: string }[] = [];
  registry.setAnnouncer((record, body) => announced.push({ record, body }));
  return { agentDir, registry, announced };
}

test("jobs: slow job is announced with exit code, tail, and origin", async () => {
  const { registry, announced } = setup();
  const h = registry.start("echo hello; sleep 0.3; echo done >&2; exit 3", { origin, graceMs: 50 });
  assert.equal(h.record.status, "running");
  const record = await h.done;
  assert.equal(record.status, "exited");
  assert.equal(record.exitCode, 3);
  assert.deepEqual(record.origin, origin);
  assert.equal(announced.length, 1);
  assert.match(announced[0].body, /^\[job:job_[0-9a-f]{8} exited 3, \ds\] echo hello/);
  assert.match(announced[0].body, /hello\ndone/);
  assert.ok(existsSync(record.logPath));
  assert.equal(readFileSync(record.logPath, "utf-8"), "hello\ndone\n");
  assert.ok(existsSync(join(record.logPath, "..", "record.json")));
});

test("jobs: job finishing inside the grace window is not announced", async () => {
  const { registry, announced } = setup();
  const h = registry.start("echo quick", { origin, graceMs: 5000 });
  assert.equal(await h.quick, true);
  const record = await h.done;
  assert.equal(record.exitCode, 0);
  assert.equal(registry.tail(h.id), "quick\n");
  assert.equal(announced.length, 0);
});

test("jobs: exactly one of {quick, announce} reports, across the grace boundary", async () => {
  const { registry, announced } = setup();
  // Many jobs closing around the grace window: whichever side of the clock
  // each lands on, quick=true must mean not announced and vice versa.
  const handles = Array.from({ length: 12 }, (_, i) =>
    registry.start(`sleep 0.0${i + 4}`, { origin, graceMs: 100 }),
  );
  const quicks = await Promise.all(handles.map((h) => h.quick));
  await Promise.all(handles.map((h) => h.done));
  const announcedIds = new Set(announced.map((a) => a.record.id));
  for (let i = 0; i < handles.length; i++) {
    assert.equal(announcedIds.has(handles[i].id), !quicks[i], `job ${i}: quick=${quicks[i]}`);
  }
  assert.equal(announced.length, quicks.filter((q) => !q).length);
});

test("jobs: kill terminates the process group and announces as killed", async () => {
  const { registry, announced } = setup();
  const h = registry.start("sleep 30", { origin, graceMs: 0 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(registry.kill(h.id), true);
  const record = await h.done;
  assert.equal(record.status, "killed");
  assert.equal(record.signal, "SIGTERM");
  assert.equal(announced.length, 1);
  assert.match(announced[0].body, /killed \(SIGTERM\)/);
  assert.equal(registry.kill(h.id), false, "already finished");
});

test("jobs: kill on an already-exited process is not recorded as killed", async () => {
  const { registry } = setup();
  const h = registry.start("exit 0", { origin });
  const record = await h.done;
  assert.equal(h.kill(), false);
  assert.equal(record.status, "exited");
});

test("jobs: killAll escalates to SIGKILL for a job that traps SIGTERM", async () => {
  const { registry, announced } = setup();
  const h = registry.start("trap '' TERM; sleep 30", { origin });
  await new Promise((r) => setTimeout(r, 150));
  const n = await registry.killAll(200);
  assert.equal(n, 1);
  const record = await h.done;
  assert.equal(record.status, "killed");
  assert.equal(record.signal, "SIGKILL");
  assert.equal(record.shutdown, true);
  assert.equal(announced.length, 0);
});

test("jobs: done resolves only after log flush and record write", async () => {
  const { registry } = setup();
  const h = registry.start("seq 1 2000", { origin, graceMs: 5000 });
  const record = await h.done;
  const recordPath = join(record.logPath, "..", "record.json");
  assert.equal(JSON.parse(readFileSync(recordPath, "utf-8")).status, "exited");
  assert.equal(readFileSync(record.logPath, "utf-8").split("\n").length, 2001);
});

test("jobs: reapOrphans kills leftover running records from a dead process", async () => {
  const { agentDir, registry } = setup();
  // Fake a job from a previous process: a live detached sleep plus a running record.
  const orphan = spawn("sleep 30", { shell: true, detached: true, stdio: "ignore" });
  orphan.unref();
  const id = "job_0badcafe";
  mkdirSync(join(agentDir, ".kern", "jobs", id), { recursive: true });
  writeFileSync(join(agentDir, ".kern", "jobs", id, "record.json"), JSON.stringify({
    id, command: "sleep 30", cwd: agentDir, pid: orphan.pid, status: "running",
    startedAt: new Date().toISOString(), logPath: join(agentDir, ".kern", "jobs", id, "output.log"), origin,
  }));
  const exited = new Promise<void>((r) => orphan.on("exit", () => r()));
  assert.equal(await registry.reapOrphans(), 1);
  await exited;
  const record = await registry.loadFromDisk(id);
  assert.equal(record?.status, "killed");
  assert.equal(record?.shutdown, true);
  assert.equal(await registry.reapOrphans(), 0, "already reaped");
});

test("jobs: ids are validated before touching disk", async () => {
  const { registry } = setup();
  assert.equal(isValidJobId("job_0badcafe"), true);
  assert.equal(isValidJobId("../../x"), false);
  assert.equal(isValidJobId("job_ZZZZZZZZ"), false);
  assert.equal(await registry.loadFromDisk("../../etc"), null);
});

test("jobs: job completes when the process exits even if a grandchild holds stdout", async () => {
  const { registry, announced } = setup();
  const t0 = Date.now();
  // The subshell exits immediately; the backgrounded sleep inherits stdout.
  const h = registry.start("(sleep 30 &) ; echo started", { origin, graceMs: 0 });
  const record = await h.done;
  assert.equal(record.status, "exited");
  assert.equal(record.exitCode, 0);
  assert.ok(Date.now() - t0 < 5000, "did not wait for the grandchild");
  assert.match(announced[0].body, /started/);
  await registry.killAll(100); // tidy the sleep's group
});

test("jobs: single kill escalates to SIGKILL and status reflects the outcome", async () => {
  const { registry } = setup();
  const h = registry.start("trap '' TERM; sleep 30", { origin });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.kill(), true);
  const record = await h.done; // needs SHUTDOWN_GRACE_MS (2s) to escalate
  assert.equal(record.status, "killed");
  assert.equal(record.signal, "SIGKILL");
  assert.equal(record.killRequested, true);
});

test("jobs: a job that traps TERM and exits normally is recorded as exited", async () => {
  const { registry } = setup();
  const h = registry.start("trap 'exit 0' TERM; sleep 30 & wait", { origin });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.kill(), true);
  const record = await h.done;
  assert.equal(record.status, "exited");
  assert.equal(record.exitCode, 0);
  assert.equal(record.killRequested, true);
});

test("jobs: reapOrphans does not signal a pid from before the current boot", async () => {
  const { agentDir, registry } = setup();
  const id = "job_0ddba11f";
  mkdirSync(join(agentDir, ".kern", "jobs", id), { recursive: true });
  writeFileSync(join(agentDir, ".kern", "jobs", id, "record.json"), JSON.stringify({
    id, command: "sleep 30", cwd: agentDir, pid: process.pid, status: "running",
    startedAt: new Date(0).toISOString(), // long before boot
    logPath: join(agentDir, ".kern", "jobs", id, "output.log"), origin,
  }));
  assert.equal(await registry.reapOrphans(), 1);
  // We are still alive — the reaper must not have signalled our pid.
  assert.equal((await registry.loadFromDisk(id))?.status, "killed");
});

test("jobs: timeout kills the job", async () => {
  const { registry } = setup();
  const h = registry.start("sleep 30", { origin, timeout: 100 });
  const record = await h.done;
  assert.equal(record.status, "killed");
});

test("jobs: killAll on shutdown suppresses announces", async () => {
  const { registry, announced } = setup();
  const a = registry.start("sleep 30", { origin });
  const b = registry.start("sleep 30", { origin });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await registry.killAll(), 2);
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.shutdown, true);
  assert.equal(rb.status, "killed");
  assert.equal(announced.length, 0);
  assert.equal(registry.countRunning(), 0);
});

test("jobs: completion body is capped and points at the log", () => {
  const record: JobRecord = {
    id: "job_deadbeef", command: "npm test", cwd: "/agent", status: "exited", exitCode: 0,
    startedAt: new Date(Date.now() - 42_000).toISOString(), finishedAt: new Date().toISOString(),
    logPath: "/agent/.kern/jobs/job_deadbeef/output.log", origin,
  };
  const body = formatCompletion(record, "");
  assert.equal(body, "[job:job_deadbeef exited 0, 42s] npm test\n(no output)\n(full log: .kern/jobs/job_deadbeef/output.log)");
});

// The routing itself is the queue's job: a completion enqueued with the
// origin envelope is spliced into that conversation's active turn, and kept
// out of a foreign one. Mirrors the queue tests for #413.
test("jobs: completion with origin envelope is isolated from a foreign turn", async () => {
  const queue = new MessageQueue();
  const handled: string[] = [];
  const drained: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((r) => { release = r; });
  queue.setHandler(async (msg, pending) => {
    handled.push(msg.text);
    if (handled.length === 1) await first;
    drained.push(...pending().map((p) => p.text));
    return `reply:${msg.text}`;
  });
  const foreign = queue.enqueue({ text: "hi", userId: "U9", interface: "telegram", channel: "telegram:999" });
  const completion = queue.enqueue({ text: "[job:x exited 0, 1s]", ...origin });
  release();
  assert.equal(await foreign, "reply:hi");
  assert.equal(await completion, "reply:[job:x exited 0, 1s]");
  assert.deepEqual(drained, []);
});

test("jobs: completion with origin envelope splices into the origin's active turn", async () => {
  const queue = new MessageQueue();
  const drained: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((r) => { release = r; });
  queue.setHandler(async (msg, pending) => {
    await first;
    drained.push(...pending().map((p) => p.text));
    return `reply:${msg.text}`;
  });
  const own = queue.enqueue({ text: "run the build", ...origin });
  const completion = queue.enqueue({ text: "[job:x exited 0, 1s]", ...origin });
  release();
  assert.equal(await own, "reply:run the build");
  assert.equal(await completion, "NO_REPLY");
  assert.deepEqual(drained, ["[job:x exited 0, 1s]"]);
});
