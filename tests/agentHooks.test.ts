import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Sessions } from "../src/agent/session.ts";
import { describeTests, failingTests, findTests, runTests } from "../src/agent/tests.ts";
import { allowTests } from "../src/agent/trust.ts";
import { makeRepo, withClaudeSettings } from "./helpers.ts";

const START = `export function load(url) {\n  try {\n    return fetch(url);\n  } catch (e) {}\n}\n`;
const SAVE = `${START}export function save(x) {\n  try {\n    db.put(x);\n  } catch (e) {}\n}\n`;

async function task(mode?: "block") {
  const root = await makeRepo({ "index.js": START, ...(mode ? { ".attentry/config.json": JSON.stringify({ mode }) } : {}) });
  const sessions = new Sessions(root);
  const hook = async (event: string, extra: object = {}) => {
    const reply = await sessions.handle({ hook_event_name: event, session_id: "s1", ...extra });
    return reply.stdout ? JSON.parse(reply.stdout) : undefined;
  };
  const edit = async (file: string, text: string) => {
    await hook("PreToolUse", { tool_name: "Write", tool_input: { file_path: join(root, file) } });
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
    return hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(root, file) } });
  };
  return { root, hook, edit };
}

test("after an edit: only problems this task added, each told once, silent when clean", async () => {
  const { hook, edit } = await task();
  await hook("SessionStart");
  assert.equal(await edit("notes.js", "export const a = 1;\n"), undefined, "nothing new: silent");
  const told = await edit("index.js", SAVE);
  assert.equal(told.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(told.hookSpecificOutput.additionalContext, /^Attentry: this edit added 1 problem:\nindex\.js:9 warning attentry\/empty-catch: /);
  assert.doesNotMatch(told.hookSpecificOutput.additionalContext, /index\.js:4/, "the empty catch from before the task isn't this task's");
  // The third edit is the first check-in, which sums up the task: not the edit's own news.
  assert.doesNotMatch((await edit("notes.js", "export const a = 2;\n")).hookSpecificOutput.additionalContext, /this edit added/, "already told: not repeated");
});

test("a check-in after 3 edits, then every 10; at the end, the change card for the person", async () => {
  const { hook, edit } = await task();
  await hook("SessionStart");
  await edit("index.js", SAVE);
  const replies = [];
  for (let i = 2; i <= 13; i++) replies[i] = await edit("notes.js", `export const a = ${i};\n`);
  assert.match(replies[3].hookSpecificOutput.additionalContext, /^Attentry check-in after 3 edits: this task added 1 problem\./, "early: a short task still has one");
  assert.equal(replies[10], undefined);
  assert.match(replies[13].hookSpecificOutput.additionalContext, /^Attentry check-in after 13 edits: this task added 1 problem\.\nFocus here:\n- index\.js:9 warning/);
  const stop = await hook("Stop", { stop_hook_active: false });
  assert.equal(stop.systemMessage, [
    "Attentry change card",
    "- Changed: 2 files (index.js, notes.js)",
    "- Problems: 1 added (1 will break)",
    "- Clean-up: 2 added (unused or copied code)",
    "- Tests: not run",
    "See them in the Attentry sidebar, or ask for Attentry's check.",
  ].join("\n"));
});

test("block mode: a new security problem comes back as an error, and the task can't finish until it's fixed", async () => {
  const { hook, edit } = await task("block");
  await hook("SessionStart");
  const risky = `export function run(req, res) {\n  res.json(eval(req.body.code));\n}\n`;
  const told = await edit("run.js", risky);
  assert.equal(told.decision, "block");
  assert.match(told.reason, /run\.js:2 error attentry\/code-eval: /);
  const stop = await hook("Stop", { stop_hook_active: false });
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /^Attentry: not done yet\. This task added 1 security or crash problem:/);
  assert.equal((await hook("Stop", { stop_hook_active: true })).decision, undefined, "already continuing after a block: let it stop");
  await edit("run.js", `export function run(req, res) {\n  res.json({ ok: true });\n}\n`);
  assert.match((await hook("Stop", { stop_hook_active: false })).systemMessage, /^Attentry change card\n- Changed: 1 file \(run\.js\)\n- Problems: none added\n/);
});

test("suggest mode never blocks", async () => {
  const { hook, edit } = await task();
  await hook("SessionStart");
  const told = await edit("run.js", `export function run(req, res) {\n  res.json(eval(req.body.code));\n}\n`);
  assert.equal(told.decision, undefined);
  assert.match(told.hookSpecificOutput.additionalContext, /code-eval/);
  assert.equal((await hook("Stop", { stop_hook_active: false })).decision, undefined);
});

test("tests run at check-ins in the background, a failure is told once, and the card has the result", () => withClaudeSettings({}, async () => {
  const root = await makeRepo({
    "index.js": START,
    "package.json": JSON.stringify({ scripts: { test: "node check.js" } }),
    "check.js": "process.exit(require('fs').existsSync('broken') ? 1 : 0);\n",
    ".attentry/config.json": JSON.stringify({ checkInEvery: 2 }),
  });
  await allowTests(root, await findTests(root, undefined)); // what `attentry init` does
  const sessions = new Sessions(root, true);
  const hook = async (event: string, extra: object = {}) => {
    const reply = await sessions.handle({ hook_event_name: event, session_id: "s1", ...extra });
    return reply.stdout ? JSON.parse(reply.stdout) : undefined;
  };
  const edit = async (file: string, text: string) => {
    await writeFile(join(root, file), text);
    return hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(root, file) } });
  };
  await hook("SessionStart");
  await edit("broken", "");
  await edit("notes.md", "a"); // the second edit: a check-in, and the tests start
  await new Promise((r) => setTimeout(r, 3000));
  const told = await edit("notes.md", "b");
  assert.match(told.hookSpecificOutput.additionalContext, /Attentry: the tests failed at the last check-in \(npm test\):[^]*Fix them before going on/);
  const again = await edit("notes.md", "c");
  assert.doesNotMatch(again?.hookSpecificOutput?.additionalContext ?? "", /tests failed/, "told once");
  await rm(join(root, "broken"));
  const stop = await hook("Stop", { stop_hook_active: false });
  assert.match(stop.systemMessage, /\n- Tests: passed \(npm test, \d+s\)/, "run again on the final code");
}));

// A background session in a repo whose check-ins come every 2 edits; `edit` waits for the tests
// the check-in started, so the next edit hears them.
async function checkInRepo(files: Record<string, string>) {
  const root = await makeRepo({ "index.js": START, ".attentry/config.json": JSON.stringify({ checkInEvery: 2 }), ...files });
  const sessions = new Sessions(root, true);
  const edit = async (text: string) => {
    await writeFile(join(root, "notes.md"), text);
    const reply = await sessions.handle({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Write", tool_input: { file_path: join(root, "notes.md") } });
    await new Promise((r) => setTimeout(r, 1500));
    return reply.stdout ? (JSON.parse(reply.stdout).hookSpecificOutput.additionalContext as string) : "";
  };
  await sessions.handle({ hook_event_name: "SessionStart", session_id: "s1" });
  return { root, edit };
}

test("after a check-in the agent hears every test result: passed each run; not allowed, or no tests, once a task", () => withClaudeSettings({}, async () => {
  const passing = await checkInRepo({ "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }) });
  await allowTests(passing.root, await findTests(passing.root, undefined));
  await passing.edit("a");
  await passing.edit("b"); // a check-in: the tests start
  assert.match(await passing.edit("c"), /^Attentry: the tests passed at the last check-in \(npm test, \d+s\)\.$/);
  await passing.edit("d");
  assert.match(await passing.edit("e"), /tests passed/, "told after every run");

  const blocked = await checkInRepo({ "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }) });
  await blocked.edit("a");
  await blocked.edit("b");
  assert.match(await blocked.edit("c"), /^Attentry: the tests \(npm test\) didn't run at the check-in: the person hasn't allowed them for this folder yet\. Tell them: Allow tests in the Attentry sidebar\.$/);
  await blocked.edit("d");
  assert.doesNotMatch(await blocked.edit("e"), /tests/, "once a task");

  const none = await checkInRepo({});
  await none.edit("a");
  await none.edit("b");
  assert.match(await none.edit("c"), /^Attentry: this project has no tests yet, so the check-ins can't run any\./);
  await none.edit("d");
  assert.doesNotMatch(await none.edit("e"), /tests/, "once a task");
}));

const NOTES_APP = `const express = require("express");\nconst app = express();\napp.get("/api/notes", (req, res) => res.json([]));\napp.post("/api/notes", (req, res) => res.status(201).json(req.body));\nmodule.exports = app;\n`;
const NOTES_TEST = `const request = require("supertest");\nconst app = require("../app");\ntest("lists", () => request(app).get("/api/notes").expect(200));\n`;

test("no plan: the check-in names the tests the routes this task wrote need, once; not with a plan, not for tested routes", async () => {
  const { hook, edit } = await task();
  await hook("SessionStart");
  await edit("app.js", NOTES_APP);
  await edit("tests/notes.test.js", NOTES_TEST);
  const checkIn = (await edit("notes.md", "a")).hookSpecificOutput.additionalContext as string;
  assert.match(checkIn, /^Attentry check-in after 3 edits[^]*\n\nTests for the routes this task wrote \(no plan said which\):\n- `POST \/api\/notes`: the normal case works/);
  assert.doesNotMatch(checkIn, /`GET \/api\/notes`/, "it has a test already");
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await edit("notes.md", String(i));
  assert.doesNotMatch((await edit("notes.md", "b")).hookSpecificOutput.additionalContext, /Tests for the routes/, "once a task");

  // A route that was there before the task, in a file it edits, isn't one it wrote.
  const root = await makeRepo({ "app.js": NOTES_APP });
  const sessions = new Sessions(root);
  await sessions.handle({ hook_event_name: "SessionStart", session_id: "s2" });
  let reply;
  for (const i of [1, 2, 3]) {
    await writeFile(join(root, "app.js"), NOTES_APP.replace("module.exports", `app.delete("/api/notes/:id", (req, res) => res.status(204).end());\n// ${i}\nmodule.exports`));
    reply = await sessions.handle({ hook_event_name: "PostToolUse", session_id: "s2", tool_name: "Write", tool_input: { file_path: join(root, "app.js") } });
  }
  const added = JSON.parse(reply!.stdout).hookSpecificOutput.additionalContext as string;
  assert.match(added, /- `DELETE \/api\/notes\/:id`: the normal case works/);
  assert.doesNotMatch(added, /`(GET|POST) \/api\/notes`/, "there before the task");

  const planned = await task();
  await planned.hook("SessionStart");
  await planned.hook("PreToolUse", { tool_name: "ExitPlanMode", tool_input: { plan: "Add GET and POST /api/notes in app.js." } });
  await planned.edit("app.js", NOTES_APP);
  await planned.edit("notes.md", "a");
  assert.doesNotMatch((await planned.edit("notes.md", "b")).hookSpecificOutput.additionalContext, /Tests for the routes/, "the plan check already said which");
});

test("the greeting promises the tests only as far as the check-ins will run them", () => withClaudeSettings({}, async () => {
  const hello = async (files: Record<string, string>, allow = false) => {
    const root = await makeRepo({ "index.js": START, ...files });
    if (allow) await allowTests(root, await findTests(root, undefined));
    const reply = await new Sessions(root, true).handle({ hook_event_name: "SessionStart", session_id: "s1" });
    return JSON.parse(reply.stdout).hookSpecificOutput.additionalContext as string;
  };
  const script = { "package.json": JSON.stringify({ scripts: { test: "node -e 0" } }) };
  assert.match(await hello(script, true), /, and a check-in after 3 edits, then every 10\. The check-ins run the tests \(npm test\)\. If you have/);
  assert.match(await hello(script), / The check-ins will run the tests \(npm test\) once the person allows them in the Attentry sidebar\./);
  assert.match(await hello({}), /then every 10\. This project has no tests yet\. If you have/);
  assert.match(await hello({ ...script, ".attentry/config.json": JSON.stringify({ tests: "off", checkInEvery: 5 }) }), /a check-in after 3 edits, then every 5\. If you have/, "off: nothing promised");
}));

test("a repo's tests run only once the person allowed them, and again only if they haven't changed", () => withClaudeSettings({}, async () => {
  const root = await makeRepo({
    "index.js": START,
    "package.json": JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('ran', '')\"" } }),
  });
  const card = async () => {
    const sessions = new Sessions(root, true);
    await sessions.handle({ hook_event_name: "SessionStart", session_id: "s1" });
    await writeFile(join(root, "notes.md"), String(Math.random()));
    await sessions.handle({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Write", tool_input: { file_path: join(root, "notes.md") } });
    return JSON.parse((await sessions.handle({ hook_event_name: "Stop", session_id: "s1" })).stdout).systemMessage as string;
  };
  assert.match(await card(), /- Tests: not run: allow npm test first \(Allow tests in the Attentry sidebar\)/, "a cloned repo's script doesn't run on its own");
  assert.equal(existsSync(join(root, "ran")), false);
  await allowTests(root, await findTests(root, undefined));
  assert.match(await card(), /- Tests: passed \(npm test/);
  assert.equal(existsSync(join(root, "ran")), true);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  assert.match(await card(), /not run: allow npm test first/, "a changed script needs allowing again");
}));

test("a test run that hangs is stopped at its time limit, with the runner's whole process tree", async () => {
  const root = await makeRepo({ "index.js": START });
  const commands = await findTests(root, "node -e \"setTimeout(() => {}, 60000)\"");
  const started = Date.now();
  assert.equal((await runTests(commands, 1000)).state, "timeout");
  assert.ok(Date.now() - started < 15_000, "the shell's child doesn't keep the run open");
});

test("tests: the person's command, off, or found in each app of the repo", async () => {
  const root = await makeRepo({
    "frontend/package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
    "frontend/pnpm-lock.yaml": "",
    "backend/pyproject.toml": "",
    "backend/tests/test_a.py": "",
    "docs/package.json": JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }),
  });
  assert.deepEqual((await findTests(root, undefined)).map((t) => t.label).sort(), ["backend: python -m pytest -q", "frontend: pnpm test"]);
  assert.deepEqual((await findTests(root, "make check")).map((t) => t.label), ["make check"]);
  assert.deepEqual(await findTests(root, "off"), []);
});

test("two agents in one repo: each hears only about the files it edited", async () => {
  const root = await makeRepo({ "a.js": "export const a = 1;\n", "b.js": "export const b = 1;\n", "index.js": "import { a } from './a.js';\nimport { b } from './b.js';\nconsole.log(a, b);\n" });
  const sessions = new Sessions(root);
  const said = async (session: string, event: string, file?: string, text?: string) => {
    if (file) await writeFile(join(root, file), text!);
    const reply = await sessions.handle({ hook_event_name: event, session_id: session, ...(file ? { tool_name: "Write", tool_input: { file_path: join(root, file) } } : {}) });
    return reply.stdout ? JSON.parse(reply.stdout) : undefined;
  };
  await said("x", "SessionStart");
  await said("y", "SessionStart");
  const x = await said("x", "PostToolUse", "a.js", `export const a = 1;\nexport function run(req) {\n  return eval(req.body.code);\n}\n`);
  assert.match(x.hookSpecificOutput.additionalContext, /a\.js:3 error attentry\/code-eval/);
  assert.equal(await said("y", "PostToolUse", "b.js", "export const b = 2;\n"), undefined, "y's clean edit: x's problem isn't y's");
  assert.match((await said("y", "Stop")).systemMessage, /- Problems: none added/);
  assert.match((await said("x", "Stop")).systemMessage, /- Problems: 1 added \(1 security\)/);
});

test("while the first scan reads a big repo, hooks answer at once; edits made meanwhile are checked after", async () => {
  const root = await makeRepo({ "index.js": START });
  const sessions = new Sessions(root, true, 0); // no wait: as on a repo too big to read in a moment
  const hook = async (event: string, extra: object = {}) => {
    const reply = await sessions.handle({ hook_event_name: event, session_id: "s1", ...extra });
    return reply.stdout ? JSON.parse(reply.stdout) : undefined;
  };
  const edited = { tool_name: "Write", tool_input: { file_path: join(root, "index.js") } };
  const hello = await hook("SessionStart");
  assert.match(hello.hookSpecificOutput.additionalContext, /First it reads the repo \(\d+% of \d+ files?[^)]*\): edits until then are checked once it's done\./);
  assert.equal(await hook("PreToolUse", edited), undefined, "no reuse check without the repo read");
  assert.match((await hook("PostToolUse", edited)).hookSpecificOutput.additionalContext, /^Attentry is still reading the repo/);
  assert.equal(await hook("PostToolUse", edited), undefined, "told once");
  assert.equal(await hook("Stop"), undefined, "finishing doesn't wait for the scan");
  assert.match((await sessions.tool("check", { files: ["index.js"] })).text, /^Attentry is still reading this repo/);
  await sessions.readRepo();
  await writeFile(join(root, "index.js"), SAVE);
  const told = await hook("PostToolUse", edited);
  assert.match(told.hookSpecificOutput.additionalContext, /this edit added 1 problem/, "measured from the repo as it was read");
  assert.equal((await sessions.status())!.edits, 3, "edits made while reading still count");
});

test("auth set up in Next.js middleware: a route with no check of its own is 'worth a check', not a problem", async () => {
  const root = await makeRepo({
    "package.json": JSON.stringify({ dependencies: { next: "^15.0.0", "next-auth": "^5.0.0" } }),
    "middleware.ts": `export { auth as middleware } from "@/auth";\nexport const config = { matcher: ["/api/:path*"] };\n`,
    "app/api/notes/route.ts": `import { auth } from "@/auth";\nexport async function GET() {\n  const session = await auth();\n  return Response.json(await db.note.findMany({ where: { userId: session.user.id } }));\n}\n`,
  });
  const sessions = new Sessions(root);
  const hook = async (event: string, extra: object = {}) => {
    const reply = await sessions.handle({ hook_event_name: event, session_id: "s1", ...extra });
    return reply.stdout ? JSON.parse(reply.stdout) : undefined;
  };
  await hook("SessionStart");
  const file = join(root, "app/api/notes/[id]/route.ts");
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `export async function DELETE(req: Request, { params }) {\n  await db.note.delete({ where: { id: params.id } });\n  return new Response(null, { status: 204 });\n}\n`);
  const note = (await hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: file } }))?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(note, /worth a check, may be fine/);
  assert.match(note, /DELETE \/api\/notes\/\[id\] changes data with no auth check of its own; auth is set up in middleware\.ts, so check it covers this route/);
  assert.doesNotMatch(note, /this edit added/, "not reported as a problem");
  const card = (await hook("Stop"))?.systemMessage ?? "";
  assert.match(card, /Problems: none added/);
  assert.match(card, /To check: 1 route with no auth check of its own/);
});

test("a project's failing node --test is a failure, also when Attentry runs inside a test run", async () => {
  const root = await makeRepo({
    "package.json": JSON.stringify({ scripts: { test: "node --test \"tests/*.test.js\"" } }),
    "tests/a.test.js": `require("node:test")("a", () => { throw new Error("no"); });\n`,
  });
  assert.ok(process.env.NODE_TEST_CONTEXT, "this test itself runs under node --test");
  assert.equal((await runTests(await findTests(root, undefined), 60_000)).state, "failed");
});

test("the failing tests' names, read from each runner's output", () => {
  const node = "✔ cents (0.4ms)\n✖ a 10% discount on 100 is 90 (0.5567ms)\n  actual: 10\n✖ failing tests:\n\n✖ a 10% discount on 100 is 90 (0.5567ms)\n";
  assert.deepEqual(failingTests(node), ["a 10% discount on 100 is 90"]);
  assert.deepEqual(failingTests("  ✓ adds (2 ms)\n  ✕ rejects a bad id (5 ms)\n"), ["rejects a bad id"], "jest");
  assert.deepEqual(failingTests(" × splits the bill 3ms\n"), ["splits the bill"], "vitest");
  assert.deepEqual(failingTests("FAILED tests/test_pay.py::test_refund - AssertionError: 1 != 2\n"), ["test_refund"], "pytest");
  assert.equal(describeTests({ state: "failed", label: "npm test", seconds: 1, tail: [], failing: ["a", "b", "c"] }), "failed (npm test, 1s): a and 2 more");
});
