import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli/run.ts";
import { collectFindings } from "../src/findings/collect.ts";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

const rulesIn = async (files: Record<string, string>) => (await collectFindings(await scanRepo(await makeRepo(files)))).filter((f) => f.rule !== "dead-function").map((f) => `${f.line} ${f.rule}${f.evidence.some((e) => /no reason/.test(e)) ? " (no reason)" : ""}`);

test("an ignore comment with a reason hides that rule on that line", async () => {
  assert.deepEqual(await rulesIn({
    "index.js": `export function a() {\n  // attentry-ignore empty-catch: the cache is optional\n  try { load(); } catch (e) {}\n}\nexport function b() {\n  try { load(); } catch (e) {} // attentry-ignore empty-catch, catch-only-logs: same as above\n}\n`,
  }), []);
  assert.deepEqual(await rulesIn({ "app.py": `def a():\n    try:\n        load()\n    except Exception:  # attentry-ignore empty-catch: optional\n        pass\n` }), []);
});

test("an ignore without a reason, or for another rule, doesn't count", async () => {
  assert.deepEqual(await rulesIn({
    "index.js": `export function a() {\n  // attentry-ignore empty-catch\n  try { load(); } catch (e) {}\n}\nexport function b() {\n  // attentry-ignore dead-function: wrong rule\n  try { load(); } catch (e) {}\n}\n`,
  }), ["3 empty-catch (no reason)", "7 empty-catch"]);
});

test("explain gives the plain words and full steps for one line", async () => {
  const root = await makeRepo({ "index.js": `function calcTax(total) {\n  return total * 0.18;\n}\n` });
  const cwd = process.cwd();
  process.chdir(root);
  let text = "";
  try {
    assert.equal(await run(["explain", "index.js:2"], (t) => (text += t)), 0);
  } finally {
    process.chdir(cwd);
  }
  assert.match(text, /^`calcTax\(total\)`: it returns `total \* 0\.18`\.\n\n# Attentry findings/);
  assert.match(text, /## Dead functions \(1\)[\s\S]*Fix:\n1\. Delete the function/);
});

test("the text report leaves out ignored findings too", async () => {
  const root = await makeRepo({ "index.js": `export function a() {\n  // attentry-ignore empty-catch: the cache is optional\n  try { load(); } catch (e) {}\n}\nexport function b() {\n  try { load(); } catch (e) {}\n}\n` });
  let text = "";
  await run(["scan", root], (t) => (text += t));
  assert.match(text, /index\.js:6/);
  assert.doesNotMatch(text, /index\.js:3/);
});
