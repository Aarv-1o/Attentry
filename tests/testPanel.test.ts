import assert from "node:assert/strict";
import { test } from "node:test";
import { findTests } from "../src/agent/tests.ts";
import { allowTests } from "../src/agent/trust.ts";
import { runFromPanel, testsView } from "../src/testing/panel.ts";
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

test("Run for this file: blocked until the test command is allowed, then only that file's tests", () => withClaudeSettings({}, async () => {
  const root = await makeRepo(REPO);
  assert.equal((await runFromPanel(root, new Map(), "src/money.js")).state, "blocked");
  await allowTests(root, await findTests(root, undefined));
  const run = await runFromPanel(root, new Map(), "src/money.js");
  assert.equal(run.state, "passed");
  assert.equal(run.label, "tests for money.js");
  const app = await runFromPanel(root, new Map(), "src/app.js");
  assert.equal(app.state, "failed", "notes.test.js loads app.js, which calls express() without importing it");
  assert.match(app.tail.join("\n"), /notes\.test\.js/);
  assert.equal((await runFromPanel(root, new Map(), "package.json")).state, "none", "no test reaches it");
}));
