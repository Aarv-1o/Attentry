import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { writeConfig } from "../src/agent/config.ts";
import { Sessions } from "../src/agent/session.ts";
import { readTexts } from "../src/index/texts.ts";
import { scanRepo } from "../src/scan/scan.ts";
import { routeCoverage } from "../src/testing/coverage.ts";
import { suggestTests } from "../src/testing/suggest.ts";
import { makeRepo } from "./helpers.ts";

async function suggest(files: Record<string, string>, plan: string): Promise<string[]> {
  const scan = await scanRepo(await makeRepo(files));
  return suggestTests(plan, scan, routeCoverage(scan.index), await readTexts(scan.index.root, scan.index.files)).lines;
}

const APP = {
  "package.json": JSON.stringify({ dependencies: { express: "4" } }),
  "src/app.js": `import express from "express";
import notes from "./notes.js";
import admin from "./admin.js";
import auth from "./auth.js";
const app = express();
app.use("/api/auth", auth);
app.use("/api/notes", requireAuth, notes);
app.use("/api/admin", requireAuth, isAdmin, admin);
export default app;
`,
  "src/notes.js": `import { Router } from "express";
const router = Router();
router.get("/", (req, res) => res.json(Note.find({ owner: req.user.id })));
router.post("/", (req, res) => res.json(Note.create(req.body)));
export default router;
`,
  "src/admin.js": `const router = Router();\nrouter.get("/users", list);\nexport default router;\n`,
  "src/auth.js": `const router = Router();\nrouter.post("/login", login);\nexport default router;\n`,
};

test("a new route behind login that takes an id: 401, another user's id, the normal case, and the client to use", async () => {
  assert.deepEqual(await suggest(APP, "1. Add DELETE /api/notes/:id so people can remove a note.\n"), [
    "`DELETE /api/notes/:id`: no login → 401.",
    "`DELETE /api/notes/:id`: if only the owner may do this, another user's id → 403 or 404.",
    "`DELETE /api/notes/:id`: the normal case works (status and the data it returns).",
    "No route tests next to these yet: write them with supertest (`request(app)`), so they run without starting the server.",
  ]);
});

test("an admin route: not an admin → 403; a public login route: no 401", async () => {
  assert.deepEqual(await suggest(APP, "Add DELETE /api/admin/users/:id.\nAdd POST /api/auth/logout.\n"), [
    "`DELETE /api/admin/users/:id`: no login → 401.",
    "`DELETE /api/admin/users/:id`: logged in but not an admin → 403.",
    "`DELETE /api/admin/users/:id`: the normal case works (status and the data it returns).",
    "`POST /api/auth/logout`: the normal case works (status and the data it returns).",
    "No route tests next to these yet: write them with supertest (`request(app)`), so they run without starting the server.",
  ]);
});

test("a bug fix comes first; a route that hands the whole body to the model; a tested route gets nothing", async () => {
  const files = { ...APP, "tests/notes.test.js": `import app from "../src/app.js";\nawait request(app).get("/api/notes");\n` };
  assert.deepEqual(await suggest(files, "Fix the bug where POST /api/notes saves notes for the wrong user.\nGET /api/notes is fine.\n"), [
    "This fixes a bug: first write a test that fails because of it, then fix it. The test keeps it fixed.",
    "`POST /api/notes`: no login → 401.",
    "`POST /api/notes`: an extra field in the body (`role`, `isAdmin`) isn't saved.",
    "`POST /api/notes`: the normal case works (status and the data it returns).",
    "Put them in tests/notes.test.js, which tests the routes next to these.",
  ]);
});

test("at most five tests, and nothing for a plan with no routes and no bug", async () => {
  const many = await suggest(APP, "Add DELETE /api/notes/:id, PUT /api/notes/:id and GET /api/notes/:id.\n");
  assert.equal(many.length, 6); // five tests and where they go
  assert.deepEqual(await suggest(APP, "Rename the sidebar component and tidy the CSS.\n"), []);
  assert.deepEqual(await suggest(APP, "Fix the typo in the README.\n"), []);
  assert.equal((await suggest(APP, "Fix the error when saving a note twice.\n"))[0], "This fixes a bug: first write a test that fails because of it, then fix it. The test keeps it fixed.");
});

test("routes under a prefix Attentry can't read still count as next to the planned one", async () => {
  const files = {
    "requirements.txt": "fastapi\n",
    "app/api/items.py": `from fastapi import APIRouter
router = APIRouter(prefix="/items")

@router.get("/{id}")
def read_item(id: int, current_user: CurrentUser): ...
`,
    "app/main.py": `from fastapi import FastAPI\nfrom app.api import items\napp = FastAPI()\napp.include_router(items.router, prefix=settings.API_V1_STR)\n`,
    "tests/test_items.py": `def test_read(client):\n    client.get(f"{settings.API_V1_STR}/items/1")\n`,
  };
  assert.deepEqual(await suggest(files, "Add PATCH /api/v1/items/{id}/archive.\n"), [
    "`PATCH /api/v1/items/{id}/archive`: no login → 401.",
    "`PATCH /api/v1/items/{id}/archive`: if only the owner may do this, another user's id → 403 or 404.",
    "`PATCH /api/v1/items/{id}/archive`: the normal case works (status and the data it returns).",
    "Put them in tests/test_items.py, which tests the routes next to these.",
  ]);
});

test("a plan that says the route is for admins gets the admin test; tests go next to each route's own", async () => {
  const files = {
    ...APP,
    "tests/notes.test.js": `import app from "../src/app.js";\nawait request(app).get("/api/notes");\n`,
    "tests/auth.test.js": `import app from "../src/app.js";\nawait request(app).post("/api/auth/login");\n`,
  };
  assert.deepEqual(await suggest(files, "Add DELETE /api/notes/:id for admins only.\nAdd POST /api/auth/logout.\n"), [
    "`DELETE /api/notes/:id`: no login → 401.",
    "`DELETE /api/notes/:id`: logged in but not an admin → 403.",
    "`DELETE /api/notes/:id`: the normal case works (status and the data it returns).",
    "`POST /api/auth/logout`: the normal case works (status and the data it returns).",
    "Put the `DELETE /api/notes/:id` tests in tests/notes.test.js, next to the tests of the routes beside it.",
    "Put the `POST /api/auth/logout` tests in tests/auth.test.js, next to the tests of the routes beside it.",
  ]);
});

test("the switch: testSuggestions off in .attentry/config.json means no tests in the plan message", async () => {
  const root = await makeRepo({ ...APP, ".attentry/config.json": JSON.stringify({ checkInEvery: 5 }) });
  const sessions = new Sessions(root);
  const plan = async () => (await sessions.tool("check_plan", { plan: "Add DELETE /api/notes/:id.\n" })).text;
  assert.match(await plan(), /Tests this plan needs/);
  await writeConfig(root, { testSuggestions: false });
  assert.equal(await plan(), "Nothing in the plan clashes with what the repo has: go ahead.");
  assert.deepEqual(JSON.parse(await readFile(join(root, ".attentry/config.json"), "utf8")), { checkInEvery: 5, testSuggestions: false }, "the rest kept");
});
