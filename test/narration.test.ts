import test from "node:test";
import assert from "node:assert/strict";
import { buildFallbackNarration, type TurnSnapshot } from "../src/narration.js";

test("buildFallbackNarration handles step_limit with tool activity", () => {
  const snapshot: TurnSnapshot = {
    originalGoal: "Check status of the cluster and restart failing nodes",
    stepCount: 30,
    maxSteps: 30,
    toolCalls: [
      { tool: "bash", detail: "kubectl get nodes", output: "node-1 NotReady" },
    ],
  };

  const text = buildFallbackNarration("step_limit", snapshot);
  assert.match(text, /Reached step limit \(30 steps\)/);
  assert.match(text, /\n> Work is partially completed/);
  assert.match(text, /kubectl get nodes/);
  assert.match(text, /Reply "continue" to proceed/);
});

test("buildFallbackNarration handles timeout with tool activity", () => {
  const snapshot: TurnSnapshot = {
    originalGoal: "Download large dataset and parse CSV",
    stepCount: 5,
    maxSteps: 30,
    toolCalls: [
      { tool: "webfetch", detail: "https://example.com/data.csv" },
    ],
  };

  const text = buildFallbackNarration("timeout", snapshot);
  assert.match(text, /Idle timeout reached/);
  assert.match(text, /\n> Partial progress/);
  assert.match(text, /webfetch https:\/\/example\.com\/data\.csv/);
  assert.match(text, /Reply "continue" to resume/);
});

test("buildFallbackNarration handles wyd command when active vs idle", () => {
  const idleSnapshot: TurnSnapshot = {
    originalGoal: "",
    stepCount: 0,
    maxSteps: 30,
    toolCalls: [],
  };

  assert.equal(buildFallbackNarration("wyd", idleSnapshot), "> Idle — waiting for input.");

  const activeSnapshot: TurnSnapshot = {
    originalGoal: "[via matrix, matrix:!room123, user: @user:matrix, time: 2026-09-19T17:00:00-07:00]\nFixing network routes in pfSense",
    stepCount: 12,
    maxSteps: 30,
    toolCalls: [
      { tool: "read", detail: "knowledge/pfsense.md" },
    ],
  };

  const activeText = buildFallbackNarration("wyd", activeSnapshot);
  assert.match(activeText, /^> Working on step/);
  assert.doesNotMatch(activeText, /via matrix/);
  assert.match(activeText, /step 12\/30/);
  assert.match(activeText, /read knowledge\/pfsense\.md/);
});
