import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { findTests } from "../src/agent/tests.ts";
import { allowTests } from "../src/agent/trust.ts";
import { runFromPanel, testChoices, testsView } from "../src/testing/panel.ts";
import { makeRepo, withClaudeSettings } from "./helpers.ts";

const REPO = {
  "package.json": JSON.stringify({ scripts: { test: "node --test \"tests/*.test.js\"" } }),
  "src/app.js": `const app = express();
app.get("/api/notes", requireAuth, list);
app.delete("/api/notes/:id", remove);
app.get("/api/tags", requireAuth, tags);
app.post("/api/login", login);
module.exports = { app };
`,
  "src/money.js": "exports.cents = (n) => n * 100;\n",
  "tests/money.test.js": `const { test } = require("node:test");\nconst assert = require("node:assert");\nconst { cents } = require("../src/money.js");\ntest("cents", () => assert.equal(cents(1), 100));\n`,
  "tests/notes.test.js": `const { app } = require("../src/app.js");\nrequest(app).get("/api/notes");\n`,
};

test("the Tests section: routes with no test, an open route that changes data first", async () => {
  const view = await testsView(await makeRepo(REPO), new Map(), null);
  assert.equal(view.routes, 4);
  assert.equal(view.suggestions, true);
  assert.deepEqual(view.untested.map((r) => `${r.method} ${r.path}${r.open ? " open" : ""}`), ["DELETE /api/notes/:id open", "POST /api/login", "GET /api/tags"]);
});

const files = (file: string) => ({ kind: "files" as const, files: [file], name: `Tests for ${file}` });

test("a run from the menu: blocked until the test command is allowed, then only the tests for that file", () => withClaudeSettings({}, async () => {
  const root = await makeRepo(REPO);
  assert.equal((await runFromPanel(root, new Map(), files("src/money.js"))).state, "blocked");
  await allowTests(root, await findTests(root, undefined));
  const run = await runFromPanel(root, new Map(), files("src/money.js"));
  assert.equal(run.state, "passed");
  assert.equal(run.scope, "Tests for src/money.js");
  assert.match(run.output ?? "", /^> node --test tests\/money\.test\.js\n/, "the whole output, for the Output channel");
  const app = await runFromPanel(root, new Map(), files("src/app.js"));
  assert.equal(app.state, "failed", "notes.test.js loads app.js, which calls express() without importing it");
  assert.match(app.tail.join("\n"), /notes\.test\.js/);
  assert.deepEqual(app.failingAt?.map((f) => `${f.file}:${f.line}`), ["tests/notes.test.js:1"], "node --test names the file that failed to load");
  assert.equal((await runFromPanel(root, new Map(), files("package.json"))).label, "no test reaches it");
  assert.equal((await runFromPanel(root, new Map(), { kind: "changed" })).label, "not a git repo, so no changed files");
}));

test("a failing test is found where it's written", () => withClaudeSettings({}, async () => {
  const root = await makeRepo({ ...REPO,
    "tests/money.test.js": `const { test } = require("node:test");\nconst assert = require("node:assert");\nconst { cents } = require("../src/money.js");\n\ntest("cents of one", () => assert.equal(cents(1), 99));\n` });
  await allowTests(root, await findTests(root, undefined));
  const run = await runFromPanel(root, new Map(), { kind: "files", files: ["tests/money.test.js"], name: "money.test.js" });
  assert.equal(run.state, "failed");
  assert.deepEqual(run.failingAt, [{ name: "cents of one", file: "tests/money.test.js", line: 5 }]);
}));

test("the run menu's choices: the command, the open file's tests, the changed files' tests, every test file", async () => {
  const root = await makeRepo(REPO);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args]);
  assert.equal((await testChoices(root, new Map(), undefined)).changed, undefined, "outside git, no changed files");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "first");
  await writeFile(join(root, "src/money.js"), "exports.cents = (n) => Math.round(n * 100);\n");
  assert.deepEqual(await testChoices(root, new Map(), "src/money.js"), {
    command: "npm test", open: { file: "src/money.js", tests: 1 }, changed: 1, files: ["tests/money.test.js", "tests/notes.test.js"],
  });
});
