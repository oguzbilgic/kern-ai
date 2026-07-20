import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ModelMessage } from "ai";
import {
  MEDIA_SCHEME,
  MediaSidecar,
  buildUserContent,
  resolveMediaInMessages,
  stripUnresolvedMedia,
} from "../src/plugins/media/media.js";
import { mediaPlugin } from "../src/plugins/media/plugin.js";

const CONFIG = { mediaDigest: false, mediaContext: 2 } as any;

async function makeAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "kern-media-test-"));
  await mkdir(join(agentDir, ".kern", "media"), { recursive: true });
  await mkdir(join(agentDir, ".kern", "sessions"), { recursive: true });
  return agentDir;
}

function sidecarFor(agentDir: string): MediaSidecar {
  return new MediaSidecar(join(agentDir, ".kern", "sessions"), "test-session", null);
}

/** Assert no kern-media:// URI remains anywhere in the message array. */
function assertNoRawRefs(messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const p of msg.content as any[]) {
      if (typeof p.image === "string") assert.ok(!p.image.startsWith(MEDIA_SCHEME), `raw image ref leaked: ${p.image}`);
      if (typeof p.data === "string") assert.ok(!p.data.startsWith(MEDIA_SCHEME), `raw file ref leaked: ${p.data}`);
    }
  }
}

function mediaMessage(uri: string, image = true): ModelMessage {
  return {
    role: "user",
    content: image
      ? [{ type: "image", image: uri, mediaType: "image/png" }, { type: "text", text: "look at this" }]
      : [{ type: "file", data: uri, mediaType: "application/pdf", filename: "doc.pdf" }],
  } as ModelMessage;
}

test("existing file within mediaContext resolves to a buffer", async () => {
  const agentDir = await makeAgentDir();
  try {
    await writeFile(join(agentDir, ".kern", "media", "abc123.png"), Buffer.from([1, 2, 3]));
    const messages = [mediaMessage(`${MEDIA_SCHEME}abc123.png`)];
    const out = await resolveMediaInMessages(messages, sidecarFor(agentDir), agentDir, CONFIG);
    const part = (out[0].content as any[])[0];
    assert.equal(part.type, "image");
    assert.ok(part.image instanceof Uint8Array);
    assertNoRawRefs(out);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("missing file becomes a text placeholder, never a raw URI", async () => {
  const agentDir = await makeAgentDir();
  try {
    const messages = [
      mediaMessage(`${MEDIA_SCHEME}gone.png`),
      mediaMessage(`${MEDIA_SCHEME}gone.pdf`, false),
    ];
    const out = await resolveMediaInMessages(messages, sidecarFor(agentDir), agentDir, CONFIG);
    assertNoRawRefs(out);
    assert.match((out[0].content as any[])[0].text, /attached image: gone\.png/);
    assert.match((out[1].content as any[])[0].text, /attached file: gone\.pdf/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("unreadable path (EISDIR) falls back to placeholder instead of throwing", async () => {
  const agentDir = await makeAgentDir();
  try {
    // existsSync passes but readFileSync throws — the crash path behind the
    // "URL scheme must be http, https, or data" lockup.
    await mkdir(join(agentDir, ".kern", "media", "trap.png"));
    const messages = [mediaMessage(`${MEDIA_SCHEME}trap.png`)];
    const out = await resolveMediaInMessages(messages, sidecarFor(agentDir), agentDir, CONFIG);
    assertNoRawRefs(out);
    assert.match((out[0].content as any[])[0].text, /attached image: trap\.png/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("digest path with unreadable file does not throw", async () => {
  const agentDir = await makeAgentDir();
  try {
    await mkdir(join(agentDir, ".kern", "media", "trap.png"));
    const messages = [mediaMessage(`${MEDIA_SCHEME}trap.png`)];
    const config = { mediaDigest: true, mediaContext: 2, provider: "openai", model: "gpt-x" } as any;
    const out = await resolveMediaInMessages(messages, sidecarFor(agentDir), agentDir, config);
    assertNoRawRefs(out);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("stripUnresolvedMedia replaces leftover refs in any role", () => {
  const messages: ModelMessage[] = [
    mediaMessage(`${MEDIA_SCHEME}a.png`),
    {
      role: "assistant",
      content: [
        { type: "text", text: "here" },
        { type: "image", image: `${MEDIA_SCHEME}b.jpg`, mediaType: "image/jpeg" },
      ],
    } as ModelMessage,
    { role: "user", content: "plain text untouched" },
  ];
  const out = stripUnresolvedMedia(messages);
  assertNoRawRefs(out);
  assert.match((out[1].content as any[])[1].text, /attached image: b\.jpg \(unavailable\)/);
  assert.equal(out[2].content, "plain text untouched");
  // Non-media parts and resolved buffers pass through unchanged
  assert.equal((out[1].content as any[])[0].text, "here");
});

test("plugin resolveMessages resolves even without an initialized sidecar", async () => {
  const agentDir = await makeAgentDir();
  try {
    await writeFile(join(agentDir, ".kern", "media", "late.png"), Buffer.from([9]));
    const ctx = {
      agentDir,
      config: CONFIG,
      db: null,
      sessionId: () => null, // no session — previously caused a wholesale bypass
    } as any;
    const messages = [mediaMessage(`${MEDIA_SCHEME}late.png`), mediaMessage(`${MEDIA_SCHEME}gone.pdf`, false)];
    const out = await mediaPlugin.onMessage!.resolveMessages!(messages, ctx);
    assertNoRawRefs(out);
    assert.ok(((out[0].content as any[])[0].image) instanceof Uint8Array);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
