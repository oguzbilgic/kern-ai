import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../src/util.js";

test("stripAnsi: removes SGR color codes", () => {
  const input = "\u001b[35m/path/to/file\u001b[m:\u001b[32m24\u001b[m: \u001b[01;31mfoo\u001b[m";
  assert.equal(stripAnsi(input), "/path/to/file:24: foo");
});

test("stripAnsi: removes cursor and screen clear escapes", () => {
  const input = "\u001b[2K\u001b[1G\u001b[?25hdone";
  assert.equal(stripAnsi(input), "done");
});

test("stripAnsi: removes OSC title escapes", () => {
  const input = "\u001b]0;my window title\u0007text";
  assert.equal(stripAnsi(input), "text");
});

test("stripAnsi: preserves clean text", () => {
  const input = "clean text with [brackets] and (parentheses) 123";
  assert.equal(stripAnsi(input), input);
});
