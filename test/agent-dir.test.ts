import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type Server } from "net";
import {
  isAgentDir,
  resolveAgentDir,
  AgentDirError,
  assignPort,
  writePidFile,
  readPid,
  readLivePid,
  removePidFile,
  restartArgv,
  bindAgentServer,
} from "../src/agent-dir.js";
import { parseWebFlags } from "../src/web-daemon.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kern-agent-dir-"));
}

function listen(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(null));
    srv.listen(port, "0.0.0.0", () => resolve(srv));
  });
}

function close(srv: Server | null): Promise<void> {
  return new Promise((resolve) => (srv ? srv.close(() => resolve()) : resolve()));
}

test("isAgentDir / resolveAgentDir accept .kern/ and reject AGENTS.md-only", () => {
  const dir = tmp();
  try {
    // Empty directory
    assert.equal(isAgentDir(dir), false);
    assert.throws(() => resolveAgentDir(dir), AgentDirError);
    assert.throws(() => resolveAgentDir(dir), {
      name: "AgentDirError",
      message: `no agent in ${dir} (no .kern/ directory). Run 'kern init' there first.`,
    });

    // AGENTS.md alone is not an agent
    writeFileSync(join(dir, "AGENTS.md"), "# agent\n");
    assert.equal(isAgentDir(dir), false);
    assert.throws(() => resolveAgentDir(dir), AgentDirError);

    // .kern/ makes it one
    mkdirSync(join(dir, ".kern"));
    assert.equal(isAgentDir(dir), true);
    assert.equal(resolveAgentDir(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAgentDir defaults to the current directory", () => {
  const dir = tmp();
  const prev = process.cwd();
  try {
    mkdirSync(join(dir, ".kern"));
    process.chdir(dir);
    // realpath may differ from the tmp path on macOS, so compare through resolve
    assert.equal(isAgentDir(resolveAgentDir()), true);
    assert.equal(isAgentDir(resolveAgentDir(".")), true);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assignPort skips a port held open and returns a later one", async () => {
  const held = await listen(4100);
  try {
    const port = await assignPort();
    assert.notEqual(port, 4100);
    assert.ok(port > 4100 && port <= 4999, `expected a port after 4100, got ${port}`);
  } finally {
    await close(held);
  }
});

test("PID helpers round-trip and clear a stale PID", async () => {
  const dir = tmp();
  try {
    assert.equal(readPid(dir), null);

    await writePidFile(dir, process.pid);
    assert.equal(readPid(dir), process.pid);
    assert.equal(await readLivePid(dir), process.pid);

    await removePidFile(dir);
    assert.equal(readPid(dir), null);

    // A PID nothing owns is cleared by readLivePid
    writeFileSync(join(dir, ".kern", "agent.pid"), "999999999");
    assert.equal(readPid(dir), 999999999);
    assert.equal(await readLivePid(dir), null);
    assert.equal(existsSync(join(dir, ".kern", "agent.pid")), false);

    // Garbage is null
    writeFileSync(join(dir, ".kern", "agent.pid"), "not-a-pid");
    assert.equal(readPid(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restartArgv uses the running node binary and the package entry point", () => {
  const argv = restartArgv("/home/me/alice");
  assert.equal(argv.length, 4);
  assert.equal(argv[0], process.execPath);
  assert.match(argv[1], /[\\/]index\.js$/);
  assert.equal(argv[2], "restart");
  assert.equal(argv[3], "/home/me/alice");
});

test("parseWebFlags defaults, accepts --port/--host, rejects --port 0", () => {
  assert.deepEqual(parseWebFlags([]), { port: 8080, host: "0.0.0.0" });
  assert.deepEqual(parseWebFlags(["--port", "9090"]), { port: 9090, host: "0.0.0.0" });
  assert.deepEqual(parseWebFlags(["--host", "127.0.0.1"]), { port: 8080, host: "127.0.0.1" });
  assert.deepEqual(parseWebFlags(["--port=3000", "--host=::"]), { port: 3000, host: "::" });
  assert.deepEqual(parseWebFlags(["run", "--port", "8081"]), { port: 8081, host: "0.0.0.0" });
  assert.throws(() => parseWebFlags(["--port", "0"]), /invalid --port 0/);
  assert.throws(() => parseWebFlags(["--port", "abc"]), /invalid --port abc/);
  assert.throws(() => parseWebFlags(["--port"]), /invalid --port/);
  assert.throws(() => parseWebFlags(["--host"]), /--host requires a value/);
});

test("bindAgentServer falls back to a fresh port and saves it when the sticky port is busy", async () => {
  const dir = tmp();
  const held = await listen(4100);
  try {
    mkdirSync(join(dir, ".kern"));
    writeFileSync(join(dir, ".kern", "config.json"), JSON.stringify({ name: "t", port: 4100 }) + "\n");

    const attempts: number[] = [];
    const fakeServer = {
      async start(_host: string, port: number): Promise<number> {
        attempts.push(port);
        if (port === 4100) {
          const err: any = new Error("listen EADDRINUSE");
          err.code = "EADDRINUSE";
          throw err;
        }
        return port;
      },
    };

    const bound = await bindAgentServer(fakeServer, dir, 4100, { pinned: false });
    assert.notEqual(bound, 4100);
    assert.equal(attempts[0], 4100);
    assert.equal(attempts[1], bound);

    const saved = JSON.parse(readFileSync(join(dir, ".kern", "config.json"), "utf-8"));
    assert.equal(saved.port, bound);
    assert.equal(saved.name, "t", "other config fields are preserved");
  } finally {
    await close(held);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bindAgentServer never reassigns a port pinned by the environment", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".kern"));
    writeFileSync(join(dir, ".kern", "config.json"), JSON.stringify({ port: 4100 }) + "\n");
    const fakeServer = {
      async start(): Promise<number> {
        const err: any = new Error("listen EADDRINUSE");
        err.code = "EADDRINUSE";
        throw err;
      },
    };
    await assert.rejects(bindAgentServer(fakeServer, dir, 4100, { pinned: true }), /EADDRINUSE/);
    const saved = JSON.parse(readFileSync(join(dir, ".kern", "config.json"), "utf-8"));
    assert.equal(saved.port, 4100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bindAgentServer rethrows errors other than EADDRINUSE", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".kern"));
    const fakeServer = {
      async start(): Promise<number> {
        const err: any = new Error("listen EACCES");
        err.code = "EACCES";
        throw err;
      },
    };
    await assert.rejects(bindAgentServer(fakeServer, dir, 80, { pinned: false }), /EACCES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
