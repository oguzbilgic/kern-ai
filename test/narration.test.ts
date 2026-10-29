import test from "node:test";
import assert from "node:assert/strict";
import { buildFallbackNarration, buildNarrationPrompt, continuationHint, formatStopNotice, type TurnSnapshot } from "../src/narration.js";

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
  assert.ok(text.endsWith(continuationHint("step_limit")));
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
  assert.ok(text.endsWith(continuationHint("timeout")));
});

test("buildFallbackNarration handles wyd command during an active turn", () => {
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

test("step limit notice pluralizes correctly", () => {
  const text = buildFallbackNarration("step_limit", {
    originalGoal: "x", stepCount: 1, maxSteps: 1, toolCalls: [], lastEmittedText: "",
  });
  assert.match(text, /Reached step limit \(1 step\)/);
});

test("continuation hint offers context and redirection before \"continue\"", () => {
  for (const reason of ["step_limit", "timeout"] as const) {
    const hint = continuationHint(reason);
    assert.doesNotMatch(hint, /\n/);
    assert.ok(hint.indexOf("more context") < hint.indexOf("a different direction"));
    assert.ok(hint.indexOf("a different direction") < hint.indexOf('"continue"'));
  }
});

test("formatStopNotice without status skips the quote block", () => {
  const text = formatStopNotice("timeout", 30);
  assert.equal(text, `⏱️ Idle timeout reached.\n\n${continuationHint("timeout")}`);
  assert.doesNotMatch(text, /^> /m);
});

test("narration prompt asks for an unblocking detail on stop notices only", () => {
  const snapshot: TurnSnapshot = { originalGoal: "x", stepCount: 30, maxSteps: 30, toolCalls: [] };
  assert.match(buildNarrationPrompt("step_limit", snapshot), /operator could reply with to unblock/);
  assert.match(buildNarrationPrompt("timeout", snapshot), /operator could reply with to unblock/);
  assert.doesNotMatch(buildNarrationPrompt("wyd", snapshot), /unblock/);
});
