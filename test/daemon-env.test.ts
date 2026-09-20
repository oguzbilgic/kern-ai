import test from "node:test";
import assert from "node:assert/strict";
import { dirname } from "path";
import { applyUserEnvironment } from "../src/daemon.js";

const saved = { ...process.env };
function restore() {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, saved);
}

test("applyUserEnvironment: replaces root's identity and PATH", () => {
  process.env.HOME = "/root";
  process.env.USER = "root";
  process.env.LOGNAME = "root";
  process.env.SHELL = "/root/.local/bin/zsh";
  process.env.PATH = "/root/.nvm/versions/node/v22.0.0/bin:/usr/bin";
  process.env.SUDO_USER = "oguz";
  process.env.SUDO_UID = "1000";
  process.env.XDG_RUNTIME_DIR = "/run/user/0";

  applyUserEnvironment("alice", { uid: 1234, gid: 1234, home: "/home/alice" });

  assert.equal(process.env.HOME, "/home/alice");
  assert.equal(process.env.USER, "alice");
  assert.equal(process.env.LOGNAME, "alice");
  assert.equal(process.env.SHELL, "/bin/bash");
  assert.equal(process.env.SUDO_USER, undefined);
  assert.equal(process.env.SUDO_UID, undefined);
  assert.notEqual(process.env.XDG_RUNTIME_DIR, "/run/user/0");

  const path = process.env.PATH!.split(":");
  assert.ok(!path.some((p) => p.startsWith("/root")), "no /root entries");
  assert.ok(path.includes(dirname(process.execPath)), "runtime node dir present");
  assert.ok(path.includes("/usr/bin"));
  assert.equal(path[0], "/home/alice/.local/bin");
  restore();
});

test("applyUserEnvironment: keeps a non-root SHELL", () => {
  process.env.SHELL = "/usr/bin/zsh";
  applyUserEnvironment("bob", { uid: 1, gid: 1, home: "/home/bob" });
  assert.equal(process.env.SHELL, "/usr/bin/zsh");
  restore();
});
