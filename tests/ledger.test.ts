import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding } from "../src/findings/types.ts";
import { fixedSince, startTask } from "../src/agent/ledger.ts";

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
