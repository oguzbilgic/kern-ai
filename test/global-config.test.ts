import test from "node:test";
import assert from "node:assert/strict";
import {
  getAgentWorkspace,
  getAgentUser,
  isSystemManaged,
  assertFleetAuthority,
  GlobalConfig,
} from "../src/global-config.js";
import { AgentInfo } from "../src/registry.js";

test("getAgentWorkspace: extracts workspace from string entry", () => {
  assert.equal(getAgentWorkspace("/home/alice/workspace"), "/home/alice/workspace");
});

test("getAgentWorkspace: extracts workspace from object entry", () => {
  assert.equal(
    getAgentWorkspace({ user: "alice", workspace: "/home/alice/workspace" }),
    "/home/alice/workspace"
  );
});

test("getAgentUser: returns null for string entry", () => {
  assert.equal(getAgentUser("/home/alice/workspace"), null);
});

test("getAgentUser: returns user for object entry", () => {
  assert.equal(
    getAgentUser({ user: "alice", workspace: "/home/alice/workspace" }),
    "alice"
  );
});
