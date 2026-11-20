import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Sessions } from "../src/agent/session.ts";
import { findTests } from "../src/agent/tests.ts";
import { allowTests } from "../src/agent/trust.ts";
import { planSteps, stepOf } from "../src/testing/steps.ts";
import { makeRepo, withClaudeSettings } from "./helpers.ts";

const ALL = new Set(["src/notes.ts", "src/app.ts", "web/NoteList.tsx", "README.md"]);

test("plan steps: top-level numbered items, or headings when the plan has them; only steps that name files", () => {
  const numbered = `## Plan
1. Add the route in src/notes.ts.
   - and register it in src/app.ts
2. Show the list in web/NoteList.tsx.
3. Tell the team.
`;
  assert.deepEqual(planSteps(numbered, ALL), [
    { title: "Add the route in src/notes.ts", files: ["src/notes.ts", "src/app.ts"] },
    { title: "Show the list in web/NoteList.tsx", files: ["web/NoteList.tsx"] },
  ]);
  const headings = `## Step 1: the API\n1. Edit routes/notes.ts\n2. Edit src/app.ts\n## Step 2: the page\nEdit web/NoteList.tsx\n`;
  assert.deepEqual(planSteps(headings, ALL).map((s) => s.files), [["routes/notes.ts", "src/app.ts"], ["web/NoteList.tsx"]]);
  assert.deepEqual(planSteps("1. Edit src/notes.ts and web/NoteList.tsx.\n", ALL), [], "one step: nothing to move between");
});

test("plan steps: the edits move on only to a later step's file, not a shared or earlier one", () => {
  const steps = [{ title: "API", files: ["routes/notes.ts", "src/app.ts"] }, { title: "page", files: ["web/NoteList.tsx", "src/app.ts"] }, { title: "docs", files: ["README.md"] }];
  assert.equal(stepOf(steps, 0, "src/routes/notes.ts"), undefined, "still step 1");
  assert.equal(stepOf(steps, 0, "web/NoteList.tsx"), 1);
  assert.equal(stepOf(steps, 0, "src/app.ts"), undefined, "named in step 1 too");
  assert.equal(stepOf(steps, 1, "README.md"), 2);
  assert.equal(stepOf(steps, 2, "web/NoteList.tsx"), undefined, "back to an earlier step: no move");
});

test("plan steps: moving to the next step's files is a check-in, before ten edits", async () => {
  const root = await makeRepo({ "src/notes.js": "export const notes = [];\n", "web/list.js": "export const list = 1;\n" });
  const sessions = new Sessions(root);
  const hook = async (event: string, extra: object = {}) => {
    const reply = await sessions.handle({ hook_event_name: event, session_id: "s1", ...extra });
    return reply.stdout ? JSON.parse(reply.stdout).hookSpecificOutput?.additionalContext : undefined;
  };
  const edit = async (file: string, text: string) => {
    await writeFile(join(root, file), text);
    return hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(root, file) } });
  };
  await hook("SessionStart");
  await hook("PreToolUse", { tool_name: "ExitPlanMode", tool_input: { plan: "1. Store notes in src/notes.js.\n2. List them in web/list.js.\n" } });
  assert.equal(await edit("src/notes.js", "export const notes = [1];\n"), undefined);
  assert.equal(await edit("src/notes.js", "export const notes = [1, 2];\n"), undefined);
  assert.equal(await edit("web/list.js", "export const list = 2;\n"), "Attentry check-in after step 1 of 2 (Store notes in src/notes.js): this task added 0 problems. Nothing to fix: carry on.");
  assert.equal(await edit("web/list.js", "export const list = 3;\n"), undefined, "same step: no check-in");
});

test("plan steps: the end of a step runs the tests in the background, and a failure is told", () => withClaudeSettings({}, async () => {
  const root = await makeRepo({
    "src/notes.js": "export const notes = [];\n",
    "web/list.js": "export const list = 1;\n",
    "package.json": JSON.stringify({ scripts: { test: "node check.js" } }),
    "check.js": "process.exit(require('fs').existsSync('broken') ? 1 : 0);\n",
  });
  await allowTests(root, await findTests(root, undefined));
  const sessions = new Sessions(root, true);
  const hook = async (event: string, extra: object = {}) => {
    const reply = await sessions.handle({ hook_event_name: event, session_id: "s1", ...extra });
    return reply.stdout ? JSON.parse(reply.stdout).hookSpecificOutput?.additionalContext : undefined;
  };
  const edit = async (file: string, text: string) => {
    await writeFile(join(root, file), text);
    return hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(root, file) } });
  };
  await hook("SessionStart");
  await hook("PreToolUse", { tool_name: "ExitPlanMode", tool_input: { plan: "1. Store notes in src/notes.js.\n2. List them in web/list.js.\n" } });
  await edit("broken", "");
  await edit("src/notes.js", "export const notes = [1];\n");
  await edit("web/list.js", "export const list = 2;\n"); // step 1 done: the tests start
  await new Promise((r) => setTimeout(r, 3000));
  assert.match(await edit("web/list.js", "export const list = 3;\n") ?? "", /Attentry: the tests failed at the last check-in \(npm test\)/);
}));

test("plan steps: a later section isn't part of the last step, and a URL isn't a file", () => {
  const plan = `### 1. Reuse the helpers in src/notes.ts
### 2. The page: web/NoteList.tsx
Open http://localhost:3000/notes.html to try it.
## Files to change
- src/app.ts
`;
  assert.deepEqual(planSteps(plan, ALL), [
    { title: "1. Reuse the helpers in src/notes.ts", files: ["src/notes.ts"] },
    { title: "2. The page: web/NoteList.tsx", files: ["web/NoteList.tsx"] },
  ]);
});

test("plan steps: passing steps that share a file names them together", async () => {
  const root = await makeRepo({ "server.js": "export const a = 1;\n", "public/list.js": "export const list = 1;\n" });
  const sessions = new Sessions(root);
  const hook = async (event: string, extra: object = {}) => {
    const reply = await sessions.handle({ hook_event_name: event, session_id: "s1", ...extra });
    return reply.stdout ? JSON.parse(reply.stdout).hookSpecificOutput?.additionalContext : undefined;
  };
  const edit = async (file: string, text: string) => {
    await writeFile(join(root, file), text);
    return hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: join(root, file) } });
  };
  await hook("SessionStart");
  await hook("PreToolUse", { tool_name: "ExitPlanMode", tool_input: { plan: "1. New route in server.js.\n2. Seed data in server.js.\n3. The page in public/list.js.\n" } });
  await edit("server.js", "export const a = 2;\n");
  assert.match(await edit("public/list.js", "export const list = 2;\n") ?? "", /^Attentry check-in after steps 1-2 of 3: /);
});
