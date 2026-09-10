import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";

test("step limit notice: appends notice when steps hit maxSteps with partial text", async () => {
  let callCount = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "response-metadata", id: "1", modelId: "mock", timestamp: new Date() });
              controller.enqueue({ type: "tool-call", toolCallId: "c1", toolName: "t1", input: "{}" });
              controller.enqueue({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } } });
              controller.close();
            }
          }),
          rawCall: { rawPrompt: null, rawSettings: {} }
        };
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "response-metadata", id: "2", modelId: "mock", timestamp: new Date() });
            controller.enqueue({ type: "text-start", id: "d1" });
            controller.enqueue({ type: "text-delta", id: "d1", delta: "Partial summary of work." });
            controller.enqueue({ type: "text-end", id: "d1" });
            controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } } });
            controller.close();
          }
        }),
        rawCall: { rawPrompt: null, rawSettings: {} }
      };
    }
  });

  const maxSteps = 2;
  const res = streamText({
    model,
    tools: {
      t1: tool({
        description: "test",
        inputSchema: z.object({}),
        execute: async () => "result 1"
      })
    },
    stopWhen: stepCountIs(maxSteps),
    prompt: "do work"
  });

  let fullText = "";
  for await (const part of res.fullStream) {
    if (part.type === "text-delta") {
      fullText += part.delta || (part as any).text || "";
    }
  }

  const steps = await res.steps;
  assert.equal(steps.length, maxSteps);

  const unit = maxSteps === 1 ? "step" : "steps";
  const hasEmittedText = fullText.trim().length > 0;
  const stepNotice = hasEmittedText
    ? `\n\n⏳ Reached step limit (${maxSteps} ${unit}). Reply "continue" to proceed.`
    : `⏳ Reached step limit (${maxSteps} ${unit}). Work is partially completed. Reply "continue" to proceed.`;
  fullText += stepNotice;

  assert.ok(fullText.includes("⏳ Reached step limit (2 steps). Reply \"continue\" to proceed."));
});

test("step limit notice: pluralizes correctly when maxSteps is 1 and handles empty text", async () => {
  let callCount = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      callCount++;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "response-metadata", id: String(callCount), modelId: "mock", timestamp: new Date() });
            controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } } });
            controller.close();
          }
        }),
        rawCall: { rawPrompt: null, rawSettings: {} }
      };
    }
  });

  const maxSteps = 1;
  const res = streamText({
    model,
    stopWhen: stepCountIs(maxSteps),
    prompt: "do work"
  });

  let fullText = "";
  for await (const part of res.fullStream) {
    if (part.type === "text-delta") {
      fullText += part.delta || (part as any).text || "";
    }
  }

  const steps = await res.steps;
  assert.equal(steps.length, maxSteps);

  const unit = maxSteps === 1 ? "step" : "steps";
  const hasEmittedText = fullText.trim().length > 0;
  const stepNotice = hasEmittedText
    ? `\n\n⏳ Reached step limit (${maxSteps} ${unit}). Reply "continue" to proceed.`
    : `⏳ Reached step limit (${maxSteps} ${unit}). Work is partially completed. Reply "continue" to proceed.`;
  fullText += stepNotice;

  assert.equal(fullText, '⏳ Reached step limit (1 step). Work is partially completed. Reply "continue" to proceed.');
});
