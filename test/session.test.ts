import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, appendFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ModelMessage } from "ai";
import { SessionManager } from "../src/session.js";

async function makeAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kern-session-test-"));
}

function sessionPath(agentDir: string, id: string): string {
  return join(agentDir, ".kern", "sessions", `${id}.jsonl`);
}

function userMsg(i: number): ModelMessage {
  return { role: "user", content: `message ${i}` };
}

test("incremental appends produce the same file as a full rewrite", async () => {
  const agentDir = await makeAgentDir();
  try {
    const manager = new SessionManager(agentDir);
    await manager.init();
    const session = await manager.create("abc");

    const batches: ModelMessage[][] = [
      [userMsg(0)],
      [{ role: "assistant", content: "hi there" }, userMsg(1)],
      [userMsg(2)],
    ];
    for (const batch of batches) await manager.append(batch);

    const all = batches.flat();
    const content = await readFile(sessionPath(agentDir, "abc"), "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // Header line first, then one line per message — identical to what the
    // previous full-rewrite save() produced for the message records.
    const meta = JSON.parse(lines[0]);
    assert.equal(meta.id, "abc");
    assert.equal(meta.createdAt, session.createdAt);
    assert.deepEqual(
      lines.slice(1),
      all.map((m) => JSON.stringify(m))
    );
    assert.ok(content.endsWith("\n"));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("load() round-trips incrementally appended sessions", async () => {
  const agentDir = await makeAgentDir();
  try {
    const writer = new SessionManager(agentDir);
    await writer.init();
    await writer.create("roundtrip");
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 10; i++) {
      const msg = userMsg(i);
      messages.push(msg);
      await writer.append([msg]);
    }

    const reader = new SessionManager(agentDir);
    await reader.init();
    const loaded = await reader.load("roundtrip");
    assert.deepEqual(loaded.messages, messages);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("load() drops a torn trailing line", async () => {
  const agentDir = await makeAgentDir();
  try {
    const writer = new SessionManager(agentDir);
    await writer.init();
    await writer.create("torn");
    await writer.append([userMsg(0), userMsg(1)]);

    // Simulate a crash mid-append: partial JSON, no trailing newline.
    await appendFile(sessionPath(agentDir, "torn"), '{"role":"user","conte', "utf-8");

    const reader = new SessionManager(agentDir);
    await reader.init();
    const loaded = await reader.load("torn");
    assert.deepEqual(loaded.messages, [userMsg(0), userMsg(1)]);

    // load() must repair the file — the fragment has no trailing newline, so
    // leaving it in place would corrupt the next appended record.
    const repaired = await readFile(sessionPath(agentDir, "torn"), "utf-8");
    const repairedLines = repaired.split("\n").filter(Boolean);
    assert.equal(repairedLines.length, 3); // meta + 2 messages, fragment gone
    for (const line of repairedLines) JSON.parse(line); // every line is valid JSON

    // Appending after recovery yields a parseable file with the new record.
    await reader.append([userMsg(2)]);
    const again = new SessionManager(agentDir);
    await again.init();
    const reloaded = await again.load("torn");
    assert.deepEqual(reloaded.messages, [userMsg(0), userMsg(1), userMsg(2)]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("append() recreates the file with header if it vanished", async () => {
  const agentDir = await makeAgentDir();
  try {
    const manager = new SessionManager(agentDir);
    await manager.init();
    await manager.create("healed");
    await manager.append([userMsg(0)]);

    await unlink(sessionPath(agentDir, "healed"));
    await manager.append([userMsg(1)]);

    const reader = new SessionManager(agentDir);
    await reader.init();
    const loaded = await reader.load("healed");
    assert.equal(loaded.id, "healed");
    assert.deepEqual(loaded.messages, [userMsg(0), userMsg(1)]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("interrupted turn marker is persisted once", async () => {
  const agentDir = await makeAgentDir();
  try {
    const writer = new SessionManager(agentDir);
    await writer.init();
    await writer.create("interrupted");
    await writer.append([
      userMsg(0),
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "t1", toolName: "exec", input: {} }],
      } as ModelMessage,
    ]);

    const reader = new SessionManager(agentDir);
    await reader.init();
    const loaded = await reader.load("interrupted");
    assert.equal(loaded.messages.length, 3);
    const last = loaded.messages[2];
    assert.equal(last.role, "user");
    assert.match(String(last.content), /interrupted/);

    // A second load must not add another marker.
    const reader2 = new SessionManager(agentDir);
    await reader2.init();
    const reloaded = await reader2.load("interrupted");
    assert.equal(reloaded.messages.length, 3);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
