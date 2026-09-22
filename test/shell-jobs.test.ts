import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JobRegistry, formatCompletion, type JobRecord } from "../src/plugins/shell/registry.js";
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
  const record = await h.done;
  assert.equal(record.exitCode, 0);
  assert.equal(registry.tail(h.id), "quick\n");
  assert.equal(announced.length, 0);
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
  assert.equal(registry.killAll(), 2);
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
