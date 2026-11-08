import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { reviewPlan } from "../src/agent/plan.ts";
import { Sessions } from "../src/agent/session.ts";
import type { Finding } from "../src/findings/types.ts";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

const REPO = {
  "src/time.js": `export function timeAgo(date) {\n  const seconds = Math.floor((Date.now() - date) / 1000);\n  if (seconds < 60) return "just now";\n  if (seconds < 3600) return Math.floor(seconds / 60) + " minutes ago";\n  return Math.floor(seconds / 3600) + " hours ago";\n}\n`,
  "server.js": `const express = require("express");\nconst app = express();\napp.get("/api/users/:id", (req, res) => res.json({ id: req.params.id }));\napp.listen(3000);\n`,
  "package.json": JSON.stringify({ dependencies: { express: "4" } }),
  // Share a word with names a plan might use, and do something else.
  "src/plugin.js": `export function refreshPlugin(home) {
  return fetch(home + "/plugin.json").then((r) => r.json());
}
export function count(items) {
  return items.filter(Boolean).length;
}
`,
};

const PLAN = `## Plan
1. Add a \`formatTimeAgo(date)\` helper in src/utils/format.js for the feed.
2. Add GET /api/users/:id so the profile page can load a user.
3. Wire it up in server.js.
`;

// A hotspot needs git history; the plan check only reads the finding.
const hotspot = { rule: "hotspot", file: "server.js", line: 1, title: "Changed in 30 of 40 commits; 4 lines of code" } as Finding;

test("plan check: a helper the repo has under another name, a route that exists, a hotspot", async () => {
  const root = await makeRepo(REPO);
  const notes = reviewPlan(PLAN, await scanRepo(root), [hotspot]);
  assert.equal(notes.length, 3);
  assert.match(notes[0]!, /^`formatTimeAgo`: the repo already has `timeAgo` \(src\/time\.js:1, used in 0 places\)\. Reuse it/);
  assert.match(notes[1]!, /^server\.js is a hotspot \(changed in 30 of 40 commits; 4 lines of code\): change it in small steps/);
  assert.match(notes[2]!, /^GET \/api\/users\/:id already exists \(server\.js:3\): extend it/);
});

test("plan check: nothing to say about a plan the repo has nothing for, or a big one only as a size note", async () => {
  const scan = await scanRepo(await makeRepo(REPO));
  assert.deepEqual(reviewPlan("Add a `sendInvoiceEmail` job and POST /api/invoices.", scan, [hotspot]), []);
  // A shared word isn't the same function: refreshPlugin doesn't read a version, count doesn't format.
  assert.deepEqual(reviewPlan("Add `readPluginVersion()` and `formatCount(n, word)`.", scan, []), []);
  const big = Array.from({ length: 12 }, (_, i) => `- edit src/part${i}.ts`).join("\n");
  assert.deepEqual(reviewPlan(big, scan, []), ["The plan touches 12 files: do it in smaller steps, and check each one (Attentry's `check` tool) before the next."]);
});

test("plan check: nothing the plan already says, and a route named twice is one note", async () => {
  const scan = await scanRepo(await makeRepo(REPO));
  // Claude's own plan, which found them itself.
  const aware = "Reuse `timeAgo` instead of adding `formatTimeAgo`.\nGET /api/users/:id already exists in server.js: no change there.";
  assert.deepEqual(reviewPlan(aware, scan, []), []);
  // As Claude writes them: the route as context, as a heading, and "already exists" by one mention.
  const claudes = [
    "The page fetches one user, and the only read endpoint is `GET /api/users/:id`. We're adding a profile page.",
    "- `server.js`: `GET /api/users/:id` (already exists,",
    "  returns the user).",
    "### 3. `GET /api/users/:id` for the profile",
  ].join("\n");
  assert.deepEqual(reviewPlan(claudes, scan, []), []);
  const twice = "1. Add GET /api/users/:id for the profile.\n2. Call GET /api/users/:id from the page.";
  assert.deepEqual(reviewPlan(twice, scan, []), ["GET /api/users/:id already exists (server.js:3): extend it rather than adding another."]);
});

test("plan check: a plan file Claude writes is checked as it's written, then not said again when the plan finishes", async () => {
  const root = await makeRepo(REPO);
  const plans = await makeRepo({ ".claude/plans/ride-history.md": PLAN });
  const planFile = join(plans, ".claude/plans/ride-history.md");
  const sessions = new Sessions(root);
  const written = await sessions.handle({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Write", tool_input: { file_path: planFile, content: PLAN } });
  const told = JSON.parse(written.stdout!).hookSpecificOutput;
  assert.equal(told.hookEventName, "PostToolUse");
  assert.match(told.additionalContext, /^Attentry read the plan\. Before you start:\n- `formatTimeAgo`: the repo already has `timeAgo`/);
  const finished = await sessions.handle({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "ExitPlanMode", tool_input: { plan: PLAN } });
  assert.ok(!finished.stdout, "already heard");
  // Any other file outside the project: not this task's, and not on its change card.
  const other = join(plans, "notes.md");
  await writeFile(other, "x");
  assert.ok(!(await sessions.handle({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Write", tool_input: { file_path: other, content: "x" } })).stdout);
  const card = (await sessions.handle({ hook_event_name: "Stop", session_id: "s1" })).stdout ?? "";
  assert.doesNotMatch(card, /plans|notes\.md|\.\.\//);
});

test("plan check: the check_plan tool, for when Claude or the person asks", async () => {
  const sessions = new Sessions(await makeRepo(REPO));
  assert.match((await sessions.tool("check_plan", { plan: PLAN })).text, /^Attentry read the plan\. Before you start:\n- `formatTimeAgo`/);
  assert.equal((await sessions.tool("check_plan", { plan: "Rename the README title." })).text, "Nothing in the plan clashes with what the repo has: go ahead.");
  assert.equal((await sessions.tool("check_plan", {})).isError, true);
});

test("plan check: the hook tells Claude before it starts, and says nothing for a plan with no notes", async () => {
  const root = await makeRepo(REPO);
  const sessions = new Sessions(root);
  const hook = async (plan: string) => {
    const reply = await sessions.handle({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "ExitPlanMode", tool_input: { plan } });
    return reply.stdout ? JSON.parse(reply.stdout).hookSpecificOutput : undefined;
  };
  const told = await hook(PLAN);
  assert.equal(told.hookEventName, "PreToolUse");
  assert.equal(told.permissionDecision, undefined, "advice, never a block");
  assert.match(told.additionalContext, /^Attentry read the plan\. Before you start:\n- `formatTimeAgo`: the repo already has `timeAgo`/);
  assert.equal(await hook("Rename the README title."), undefined);
});
