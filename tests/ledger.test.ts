import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding } from "../src/findings/types.ts";
import { fixedSince, newSince, startTask } from "../src/agent/ledger.ts";

const finding = (file: string, rule: string, category: Finding["category"], title = rule): Finding => ({
  id: `${rule}:${file}:1`, rule, category, confidence: "likely", file, line: 1, title,
  evidence: [], related: [], why: "", fix: [], safety: "safe", verify: "",
});

test("fixed counts problems the task removed, not clean-up or files deleted by someone else", () => {
  const authHole = finding("server.js", "no-auth", "security");
  const crash = finding("old/app.js", "json-parse", "crash");
  const unused = finding("server.js", "dead-function", "dead-code");
  const task = startTask([authHole, crash, unused]);

  // Everything gone: the auth hole was fixed in server.js, old/ was deleted outside the task.
  const exists = (file: string) => file !== "old/app.js";
  task.editedFiles.add("server.js");
  assert.equal(fixedSince(task, [], exists), 1);

  // A file the task itself edited and then deleted: its problems are gone because of the task.
  task.editedFiles.add("old/app.js");
  assert.equal(fixedSince(task, [], exists), 2);
});

test("a hotspot whose commit count went up during the task isn't new in it; a function's finding with another name is", () => {
  const task = startTask([finding("src/lsp/server.ts", "hotspot", "hotspot", "Changed in 24 of 315 commits; 333 lines of code"), finding("a.ts", "long-params", "hygiene", "load has 6 parameters")]);
  const now = [finding("src/lsp/server.ts", "hotspot", "hotspot", "Changed in 24 of 320 commits; 333 lines of code"), finding("a.ts", "long-params", "hygiene", "save has 6 parameters")];
  assert.deepEqual(newSince(task, now).map((f) => f.title), ["save has 6 parameters"]);
});

test("a file that moved into the top hotspots during the task isn't new in it: the task can't add history", () => {
  const task = startTask([finding("src/lsp/server.ts", "hotspot", "hotspot")]);
  const now = [finding("src/lsp/server.ts", "hotspot", "hotspot"), finding("src/agent/session.ts", "hotspot", "hotspot"), finding("a.ts", "long-params", "hygiene")];
  assert.deepEqual(newSince(task, now).map((f) => `${f.file} ${f.rule}`), ["a.ts long-params"]);
});
