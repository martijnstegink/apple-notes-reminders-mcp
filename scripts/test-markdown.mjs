#!/usr/bin/env node
// Deterministic unit tests for src/markdown.ts's markdown -> Notes-HTML converter.
// Run after `npm run build`: node scripts/test-markdown.mjs

import { markdownToNotesHtml, textToHtml, escapeHtml } from "../dist/markdown.js";

let passed = 0, failed = 0;
function test(name, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log("\n=== Headings ===");
test("h1", markdownToNotesHtml("# Title"), "<h1>Title</h1>");
test("h2", markdownToNotesHtml("## Section"), "<h2>Section</h2>");
test("h3", markdownToNotesHtml("### Sub"), "<h3>Sub</h3>");
test("not a heading without space", markdownToNotesHtml("#tag line"), "<div>#tag line</div>");
test("4+ hashes is not a heading", markdownToNotesHtml("#### Not"), "<div>#### Not</div>");

console.log("\n=== Inline emphasis ===");
test("bold", markdownToNotesHtml("**bold**"), "<div><b>bold</b></div>");
test("italic star", markdownToNotesHtml("*italic*"), "<div><i>italic</i></div>");
test("italic underscore", markdownToNotesHtml("_italic_"), "<div><i>italic</i></div>");
test("bold then italic in one line", markdownToNotesHtml("**b** and *i*"), "<div><b>b</b> and <i>i</i></div>");
test("inline code", markdownToNotesHtml("`code`"), "<div><tt>code</tt></div>");
test("code span protects emphasis chars", markdownToNotesHtml("`a*b*c`"), "<div><tt>a*b*c</tt></div>");
test("link", markdownToNotesHtml("[text](https://example.com)"), '<div><a href="https://example.com">text</a></div>');

console.log("\n=== Lists ===");
test(
  "dash list",
  markdownToNotesHtml("- one\n- two\n- three"),
  "<ul><li>one</li><li>two</li><li>three</li></ul>"
);
test(
  "star list",
  markdownToNotesHtml("* one\n* two"),
  "<ul><li>one</li><li>two</li></ul>"
);
test(
  "ordered list",
  markdownToNotesHtml("1. one\n2. two"),
  "<ol><li>one</li><li>two</li></ol>"
);
test(
  "checklist syntax degrades to dash list with literal brackets",
  markdownToNotesHtml("- [ ] todo\n- [x] done"),
  "<ul><li>[ ] todo</li><li>[x] done</li></ul>"
);

console.log("\n=== Paragraphs / blank lines ===");
test(
  "consecutive plain lines become separate divs",
  markdownToNotesHtml("line one\nline two"),
  "<div>line one</div><div>line two</div>"
);
test("blank line", markdownToNotesHtml("a\n\nb"), "<div>a</div><div><br></div><div>b</div>");

console.log("\n=== Tables degrade to plain text ===");
test(
  "table row passthrough",
  markdownToNotesHtml("| A | B |\n| --- | --- |\n| 1 | 2 |"),
  "<div>| A | B |</div><div>| --- | --- |</div><div>| 1 | 2 |</div>"
);

console.log("\n=== HTML escaping ===");
test("escapes angle brackets and amp", escapeHtml('<a> & "b"'), "&lt;a&gt; &amp; &quot;b&quot;");
test(
  "markdown escapes html in plain text",
  markdownToNotesHtml("<script>alert(1)</script>"),
  "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>"
);
test(
  "link href quote-escaped to prevent attribute breakout",
  markdownToNotesHtml('[x](y" onmouseover="evil)'),
  '<div><a href="y&quot; onmouseover=&quot;evil">x</a></div>'
);

console.log("\n=== textToHtml (format=text) ===");
test("text format wraps each line, escapes html", textToHtml("a\n<b>\n\nc"), "<div>a</div><div>&lt;b&gt;</div><div><br></div><div>c</div>");

console.log(`\n${"─".repeat(50)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
