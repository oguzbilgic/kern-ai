import { test } from "node:test";
import assert from "node:assert";
import { parseFrontmatter } from "../src/plugins/skills/scanner.js";

test("parses plain key: value frontmatter", () => {
  const { meta, body } = parseFrontmatter(
    `---\nname: deploy-lxc\ndescription: Create a Debian LXC on kamrui\n---\nbody text\n`,
  );
  assert.equal(meta.name, "deploy-lxc");
  assert.equal(meta.description, "Create a Debian LXC on kamrui");
  assert.equal(body, "body text\n");
});

test("strips surrounding quotes from plain values", () => {
  const { meta } = parseFrontmatter(`---\nname: "quoted"\ndescription: 'also quoted'\n---\n`);
  assert.equal(meta.name, "quoted");
  assert.equal(meta.description, "also quoted");
});

test("folds a >- block scalar into a single line", () => {
  const { meta, body } = parseFrontmatter(
    `---\nname: product-knowledge\ndescription: >-\n  Product knowledge for three product lines.\n  This is the WHAT/WHY/GOTCHA layer.\n---\nbody\n`,
  );
  assert.equal(meta.name, "product-knowledge");
  assert.equal(
    meta.description,
    "Product knowledge for three product lines. This is the WHAT/WHY/GOTCHA layer.",
  );
  assert.equal(body, "body\n");
});

test("folded block scalars treat a blank line as a paragraph break", () => {
  const { meta } = parseFrontmatter(
    `---\ndescription: >\n  first para line one\n  line two\n\n  second para\n---\n`,
  );
  assert.equal(meta.description, "first para line one line two\nsecond para");
});

test("literal block scalars keep newlines", () => {
  const { meta } = parseFrontmatter(`---\ndescription: |\n  line one\n  line two\n---\n`);
  assert.equal(meta.description, "line one\nline two");

  const chomped = parseFrontmatter(`---\ndescription: |-\n  line one\n  line two\n---\n`);
  assert.equal(chomped.meta.description, "line one\nline two");
});

test("block scalar accepts indentation and chomping indicators", () => {
  for (const header of [">", ">-", ">+", "|", "|-", "|+", "|2", ">2-"]) {
    const { meta } = parseFrontmatter(`---\ndescription: ${header}\n  hello\n---\n`);
    assert.equal(meta.description, "hello", `header ${header}`);
  }
});

test("keys after a block scalar are still parsed", () => {
  const { meta } = parseFrontmatter(
    `---\ndescription: >-\n  folded value\n  continued\nname: after-block\n---\n`,
  );
  assert.equal(meta.description, "folded value continued");
  assert.equal(meta.name, "after-block");
});

test("indented continuation lines are never mistaken for keys", () => {
  const { meta } = parseFrontmatter(
    `---\ndescription: >-\n  usage: run this when deploying\n  more text\n---\n`,
  );
  assert.equal(meta.description, "usage: run this when deploying more text");
  assert.equal(meta.usage, undefined);
});

test("empty values and missing frontmatter are handled", () => {
  const { meta } = parseFrontmatter(`---\nname:\ndescription: real\n---\n`);
  assert.equal(meta.name, undefined);
  assert.equal(meta.description, "real");

  const none = parseFrontmatter("no frontmatter here\n");
  assert.deepEqual(none.meta, {});
  assert.equal(none.body, "no frontmatter here\n");
});
