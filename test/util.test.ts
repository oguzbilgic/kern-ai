import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, hasAnsi, ansiToHtml } from "../src/util.js";

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

test("hasAnsi: detects presence of ANSI escapes", () => {
  assert.equal(hasAnsi("hello world"), false);
  assert.equal(hasAnsi("\x1b[32mhello\x1b[0m"), true);
  assert.equal(hasAnsi("\x1b[1mbold\x1b[0m"), true);
  assert.equal(hasAnsi("\x1b[0m"), true);
});

test("ansiToHtml: converts ANSI color and style escapes to HTML tags", () => {
  const colored = ansiToHtml("\x1b[32m\x1b[1mSuccess\x1b[0m \x1b[31mError\x1b[0m \x1b[90mDim\x1b[0m");
  assert.ok(colored.includes('<font color="#a6e3a1"><b>Success</b></font>'));
  assert.ok(colored.includes('<font color="#f38ba8">Error</font>'));
  assert.ok(colored.includes('<font color="#6c7086">Dim</font>'));
});
