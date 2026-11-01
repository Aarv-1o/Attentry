import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli/run.ts";
import { makeRepo } from "./helpers.ts";

const flagRepo = fileURLToPath(new URL("fixtures/duplicates/flag", import.meta.url));

async function cli(...args: string[]): Promise<{ code: number; text: string }> {
  let text = "";
  const code = await run(args, (t) => (text += t));
  return { code, text };
}

test("scan prints copies found in a repo", async () => {
  const { code, text } = await cli("scan", flagRepo);
  assert.equal(code, 0);
  assert.match(text, /Detron scan: .*flag/);
  assert.match(text, /\d+ files, \d+ functions/);
  assert.match(text, /Copies \(3\)/);
  assert.match(text, /web\/time\.ts:1 {2}timeAgo/);
  assert.match(text, /Dead code|No dead code found/);
  assert.match(text, /Code hygiene|No code hygiene issues found/);
});

test("scan --json and --agent: the same findings, with what, why, fix, safety and how to check", async () => {
  const json = await cli("scan", flagRepo, "--json");
  assert.equal(json.code, 0);
  const data = JSON.parse(json.text);
  const copy = data.findings.find((f: { rule: string }) => f.rule === "cross-language-copy");
  assert.ok(copy);
  for (const key of ["id", "file", "line", "title", "evidence", "related", "why", "fix", "safety", "verify"]) assert.ok(key in copy, key);
  const agent = await cli("scan", flagRepo, "--agent");
  assert.match(agent.text, /^# Detron findings: /);
  assert.match(agent.text, /## Same logic in two languages \(1\)\n\nWhy: .+\nSafety: ask the user first\n/);
  assert.match(agent.text, /\nFix:\n1\. /);
  assert.match(agent.text, /\nCheck: /);
});

test("help, unknown commands and missing folders", async () => {
  assert.equal((await cli("--help")).code, 0);
  assert.equal((await cli()).code, 2);
  const unknown = await cli("fix", ".");
  assert.equal(unknown.code, 2);
  assert.match(unknown.text, /Unknown command: fix/);
  const typo = await cli("scan", ".", "all");
  assert.equal(typo.code, 2);
  assert.match(typo.text, /Did you mean --all\?/);
  const missing = await cli("scan", "no/such/folder");
  assert.equal(missing.code, 2);
  assert.match(missing.text, /that folder doesn't exist/);
  const badOut = await cli("scan", flagRepo, "--markdown", "--out", "no/such/folder/report.md");
  assert.deepEqual(badOut, { code: 1, text: "Can't write no/such/folder/report.md: that folder doesn't exist.\n" });
});

test("scan says which files it couldn't check", async () => {
  const root = await makeRepo({ "src/a.ts": "export const a = 1;\n", "src/Nav.vue": "<template></template>\n", "src/Hero.vue": "" });
  const { text } = await cli("scan", root);
  assert.match(text, /Not checked: 2 .vue files \(not supported yet\)/);
});
