import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/run.ts";
import { collectFindings } from "../src/findings/collect.ts";
import { partOf } from "../src/findings/severity.ts";
import type { Finding } from "../src/findings/types.ts";
import { changedLines, isInChanges } from "../src/scan/changes.ts";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { encoding: "utf8" });

const OLD = `export function load(url) {\n  try {\n    return fetch(url);\n  } catch (e) {}\n}\n`;
const NEW = `${OLD}function calcTax(total) {\n  return total * 0.18;\n}\n`;

async function branchRepo() {
  const root = await makeRepo({ "index.js": OLD });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  git(root, "checkout", "-qb", "feature");
  await writeFile(join(root, "index.js"), NEW);
  git(root, "commit", "-qam", "agent change");
  await writeFile(join(root, "extra.js"), `export const x = 1;\n`);
  return root;
}

test("your changes: a branch since it left main, plus new files", async () => {
  const root = await branchRepo();
  const changes = await changedLines(root);
  assert.ok(changes.ok);
  assert.deepEqual([...(changes.files.get("index.js") as Set<number>)].sort((a, b) => a - b), [6, 7, 8]);
  assert.equal(changes.files.get("extra.js"), "all");
  const findings = await collectFindings(await scanRepo(root));
  const rules = (fs: typeof findings) => fs.map((f) => f.rule).sort();
  assert.deepEqual(rules(findings.filter((f) => isInChanges(f, changes))), ["dead-function", "unused-file"]);
  assert.ok(rules(findings).includes("empty-catch"), "the old empty catch is still found, just not 'yours'");
});

test("on main, your changes are what isn't committed", async () => {
  const root = await makeRepo({ "index.js": OLD });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  await writeFile(join(root, "index.js"), NEW);
  const changes = await changedLines(root);
  assert.ok(changes.ok && changes.base === "HEAD");
  assert.equal((changes.files.get("index.js") as Set<number>).size, 3);
});

test("scan --changed: plain words for people, one line each for agents", async () => {
  const root = await branchRepo();
  let text = "";
  assert.equal(await run(["scan", root, "--changed"], (t) => (text += t)), 0);
  assert.match(text, /^Clean-up \(2\)\n {2}extra\.js:1 {2}Unused file.*\n {2}index\.js:6 {2}Dead function: calcTax\n {6}`calcTax\(total\)`: it returns `total \* 0\.18`\./);
  assert.match(text, /1 older finding from before this change/);
  let brief = "";
  await run(["scan", root, "--changed", "--brief"], (t) => (brief += t));
  assert.equal(brief, "", "clean-up isn't sent to agents: nothing to say");
  let all = "";
  await run(["scan", root, "--brief"], (t) => (all += t));
  assert.match(all, /^index\.js:4 warning attentry\/empty-catch: /);
});

test("without git, everything counts as yours", async () => {
  const root = await makeRepo({ "index.js": NEW });
  const changes = await changedLines(root);
  assert.equal(changes.ok, false);
  const findings = await collectFindings(await scanRepo(root));
  assert.ok(findings.every((f) => isInChanges(f, changes)));
});

test("a route nothing calls is clean-up; a call to a missing route will break", () => {
  const base: Omit<Finding, "rule"> = { id: "x", category: "frontend-backend", confidence: "likely", file: "a.js", line: 1, title: "", evidence: [], related: [], why: "", fix: [], safety: "ask-first", verify: "" };
  assert.equal(partOf({ ...base, rule: "unused-route" }), "cleanup");
  assert.equal(partOf({ ...base, rule: "missing-route" }), "breaks");
});

test("a repo right after git init, with no commits yet, scans like any other", async () => {
  const root = await makeRepo({ "index.js": OLD });
  git(root, "init", "-q");
  const result = await scanRepo(root);
  assert.deepEqual(result.history, { ok: false, reason: "no commits yet" });
  assert.deepEqual(await changedLines(root), { ok: false, reason: "no commits yet" });
});
