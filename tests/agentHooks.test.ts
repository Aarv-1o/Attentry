import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Sessions } from "../src/agent/session.ts";
import { findTests, runTests } from "../src/agent/tests.ts";
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
  assert.equal(await edit("notes.js", "export const a = 2;\n"), undefined, "already told: not repeated");
});

test("every 10 edits, a check-in; at the end, the change card for the person", async () => {
  const { hook, edit } = await task();
  await hook("SessionStart");
  await edit("index.js", SAVE);
  let reply;
  for (let i = 2; i <= 10; i++) reply = await edit("notes.js", `export const a = ${i};\n`);
  assert.match(reply.hookSpecificOutput.additionalContext, /^Attentry check-in after 10 edits: this task added 1 problem\.\nFocus here:\n- index\.js:9 warning/);
  const stop = await hook("Stop", { stop_hook_active: false });
  assert.equal(stop.systemMessage, [
    "Attentry change card",
    "- Changed: 2 files (index.js, notes.js)",
    "- Problems: 1 added (1 will break)",
    "- Clean-up: 2 added (unused or copied code)",
    "- Tests: not run",
    "See them with `attentry scan --changed` or in the Attentry sidebar.",
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
  assert.match(await card(), /- Tests: not run: allow npm test first \(run `attentry init` here/, "a cloned repo's script doesn't run on its own");
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
