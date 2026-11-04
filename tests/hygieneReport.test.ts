import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLineFindings } from "../src/report/hygiene.ts";
import type { LineFinding } from "../src/rules/line/types.ts";

const finding = (rule: string, file: string, line: number, confidence: LineFinding["confidence"], message: string): LineFinding =>
  ({ rule, file, line, confidence, message });

test("hygiene report: grouped by rule, one shared message, safe-to-fix marks, hints hidden", () => {
  const text = formatLineFindings("Code hygiene", [
    finding("catch-only-logs", "b.tsx", 9, "likely", "Error is only logged: the user never finds out it failed."),
    finding("catch-only-logs", "a.tsx", 3, "likely", "Error is only logged: the user never finds out it failed."),
    finding("unused-param", "c.js", 4, "sure", "extract: id is never used."),
    finding("deep-nesting", "d.js", 1, "likely", "run: 6 levels deep. Return early to flatten it."),
    finding("deep-nesting", "e.js", 7, "likely", "go: 5 levels deep. Return early to flatten it."),
    finding("long-params", "f.js", 2, "maybe", "many: 6 parameters."),
  ], false);
  assert.match(text, /Errors only logged \(2\)\n {5}a\.tsx:3\n {5}b\.tsx:9\n {5}→ Error is only logged: the user never finds out it failed\./);
  assert.match(text, /c\.js:4 {2}\(safe to fix\)\n {5}→ extract: id is never used\./);
  assert.match(text, /d\.js:1 {2}run: 6 levels deep/);
  assert.match(text, /1 more hint hidden/);
  assert.doesNotMatch(text, /Long parameter lists/);
  assert.match(formatLineFindings("Code hygiene", [], false), /No code hygiene issues found/);
});

test("hygiene report: with --all, hints say they're hints", () => {
  const text = formatLineFindings("Code hygiene", [finding("long-params", "f.js", 2, "maybe", "many: 6 parameters.")], true);
  assert.match(text, /f\.js:2 {2}\(hint\)/);
});
