import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Sessions } from "../src/agent/session.ts";
import { makeRepo } from "./helpers.ts";

const TIME_AGO = `(date) {
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  return Math.floor(seconds / 3600) + "h ago";
}`;

const REPO = {
  "utils/time.js": `export function timeAgo${TIME_AGO}\n`,
  "utils/date.js": `export function formatDate(d) {\n  return new Date(d).toLocaleDateString("en-IN");\n}\n`,
  "feed.js": `import { timeAgo } from "./utils/time.js";\nimport { formatDate } from "./utils/date.js";\nexport const label = (p) => timeAgo(p.at) + " " + formatDate(p.at);\nexport const short = (p) => timeAgo(p.at);\n`,
};

async function agent(extra: Record<string, string> = {}) {
  const root = await makeRepo({ ...REPO, ...extra });
  const sessions = new Sessions(root);
  const before = async (tool: string, file: string, input: object) => {
    const reply = await sessions.handle({ hook_event_name: "PreToolUse", session_id: "s", tool_name: tool, tool_input: { file_path: join(root, file), ...input } });
    return reply.stdout ? JSON.parse(reply.stdout).hookSpecificOutput : undefined;
  };
  return { before };
}

test("before writing a copy of an existing helper, the agent hears where it is", async () => {
  const { before } = await agent();
  const said = await before("Write", "page.js", { content: `export function fileTimeAgo${TIME_AGO}\n` });
  assert.equal(said.hookEventName, "PreToolUse");
  assert.equal(said.permissionDecision, undefined, "suggest mode never refuses");
  assert.equal(said.additionalContext, [
    "Attentry: before you add this function, the repo already has one that does this:",
    "- `fileTimeAgo`: `timeAgo` in utils/time.js:1 (used in 2 places) has the same code, only the names differ. Instead of a copy, import it.",
    "Reuse it, or say why a new one is needed.",
  ].join("\n"));
  assert.equal(await before("Write", "page.js", { content: `export function fileTimeAgo${TIME_AGO}\n` }), undefined, "said once");
});

test("block mode refuses an exact copy", async () => {
  const { before } = await agent({ ".attentry/config.json": JSON.stringify({ mode: "block" }) });
  const said = await before("Write", "page.js", { content: `export function fileTimeAgo${TIME_AGO}\n` });
  assert.equal(said.permissionDecision, "deny");
  assert.match(said.permissionDecisionReason, /`timeAgo` in utils\/time\.js:1/);
});

test("an edit adding a function with a name the repo already uses, elsewhere, is pointed out", async () => {
  const { before } = await agent({ "page.js": "export const page = 1;\n" });
  const said = await before("Edit", "page.js", { old_string: "export const page = 1;\n", new_string: "export const page = 1;\nexport function formatDate(x) {\n  return x.toISOString();\n}\n" });
  assert.match(said.additionalContext, /- `formatDate`: `formatDate` in utils\/date\.js:1 \(used in 1 place\) has the same name\. Instead of a copy, import it\./);
});

test("silent when the edit changes an existing function, adds a one-word one, or is a test", async () => {
  const { before } = await agent({ "page.js": "export function load() {\n  return 1;\n}\n" });
  assert.equal(await before("Edit", "utils/time.js", { old_string: '"just now"', new_string: '"now"' }), undefined, "changing timeAgo itself");
  assert.equal(await before("Edit", "page.js", { old_string: "return 1;", new_string: "return 2;" }), undefined);
  assert.equal(await before("Write", "other.js", { content: "export function load() {\n  return 3;\n}\n" }), undefined, "one-word names are too common");
  assert.equal(await before("Write", "tests/time.test.js", { content: `function fileTimeAgo${TIME_AGO}\n` }), undefined, "tests repeat on purpose");
});

test("a copy of a helper inside another file says to move it somewhere shared; callbacks in objects don't count", async () => {
  const { before } = await agent({
    "page.js": `export function Page() {\n  function timeAgo${TIME_AGO}\n  return timeAgo(1);\n}\n`,
    "hooks.js": "export const opts = { onSettled: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); } };\n",
  });
  const said = await before("Write", "other.js", { content: `export function Other() {\n  function ago${TIME_AGO}\n  return ago(2);\n}\n` });
  assert.match(said.additionalContext, /`ago`: `timeAgo` in (utils\/time\.js:1|page\.js:2)/);
  assert.equal(await before("Write", "more.js", { content: "export const more = { onSettled: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); } };\n" }), undefined);
});
