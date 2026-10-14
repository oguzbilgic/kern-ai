import test from "node:test";
import assert from "node:assert/strict";
import { MessageQueue } from "../src/queue.js";

const base = { userId: "U1", interface: "slack" };

// Handler that blocks the first turn until released, then drains pending
// same-channel messages (as prepareStep would) before finishing.
function setup() {
  const queue = new MessageQueue();
  const handled: string[] = [];
  const drained: string[] = [];
  let release!: () => void;
  const firstTurn = new Promise<void>((r) => { release = r; });
  queue.setHandler(async (msg, pending) => {
    handled.push(msg.text);
    if (handled.length === 1) await firstTurn;
    drained.push(...pending().map((p) => p.text));
    return `reply:${msg.text}`;
  });
  return { queue, handled, drained, release };
}

test("queue: message on a different channel runs as its own turn (#413)", async () => {
  const { queue, handled, drained, release } = setup();
  const a = queue.enqueue({ ...base, text: "A", channel: "slack-dm:U1" });
  const b = queue.enqueue({ ...base, userId: "U2", text: "B", channel: "slack-dm:U2" });
  release();
  assert.equal(await a, "reply:A");
  assert.equal(await b, "reply:B");
  assert.deepEqual(handled, ["A", "B"]);
  assert.deepEqual(drained, []);
});

test("queue: same-channel message is injected into the active turn", async () => {
  const { queue, handled, drained, release } = setup();
  const a = queue.enqueue({ ...base, text: "A", channel: "slack-dm:U1" });
  const c = queue.enqueue({ ...base, text: "C", channel: "slack-dm:U1" });
  release();
  assert.equal(await a, "reply:A");
  assert.equal(await c, "NO_REPLY");
  assert.deepEqual(handled, ["A"]);
  assert.deepEqual(drained, ["C"]);
});
