import test from "node:test";
import assert from "node:assert/strict";
import { buildFallbackNarration, buildNarrationPrompt, type TurnSnapshot } from "../src/narration.js";

test("buildFallbackNarration handles step_limit with tool activity", () => {
  const snapshot: TurnSnapshot = {
    originalGoal: "Check status of the cluster and restart failing nodes",
    stepCount: 30,
    maxSteps: 30,
    toolCalls: [
      { tool: "bash", detail: "kubectl get nodes" },
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

test("buildNarrationPrompt includes every tool call and never tool output", () => {
  const snapshot: TurnSnapshot = {
    originalGoal: "[via tui, user: op, time: 2026-09-19T17:00:00-07:00]\ncheck disks",
    stepCount: 7,
    maxSteps: 30,
    toolCalls: Array.from({ length: 7 }, (_, i) => ({ tool: "bash", detail: `df -h host${i}` })),
    lastEmittedText: "Checking all hosts now.",
  };
  const prompt = buildNarrationPrompt("wyd", snapshot);
  assert.match(prompt, /Original user request: "check disks"/);
  assert.doesNotMatch(prompt, /via tui/);
  assert.match(prompt, /Tool activity this turn:/);
  for (let i = 0; i < 7; i++) assert.match(prompt, new RegExp(`${i + 1}\\. bash\\(df -h host${i}\\)`));
  assert.doesNotMatch(prompt, /output/);
  assert.match(prompt, /Agent text so far: "Checking all hosts now."/);
});

test("buildNarrationPrompt chains off the previous narration and only includes the delta", () => {
  const snapshot: TurnSnapshot = {
    originalGoal: "check disks",
    stepCount: 5,
    maxSteps: 30,
    toolCalls: [
      { tool: "bash", detail: "df -h kamrui" },
      { tool: "bash", detail: "df -h vega" },
      { tool: "bash", detail: "pct exec 130 -- df -h" },
    ],
    lastEmittedText: "kamrui and vega fine. Now checking LXC 130.",
    lastNarration: {
      text: "Checked kamrui and vega disks, both healthy.",
      step: 3,
      toolIndex: 2,
      textLen: "kamrui and vega fine.".length,
    },
  };
  const prompt = buildNarrationPrompt("step_limit", snapshot);
  assert.match(prompt, /Previous status \(given at step 3\): "Checked kamrui and vega disks, both healthy."/);
  assert.match(prompt, /Tool activity since then:/);
  assert.doesNotMatch(prompt, /df -h kamrui/);
  assert.doesNotMatch(prompt, /df -h vega/);
  assert.match(prompt, /3\. bash\(pct exec 130 -- df -h\)/);
  assert.match(prompt, /Agent text since then: "Now checking LXC 130."/);
  assert.match(prompt, /Do not repeat the previous status/);
});
