import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { contentAfter, editsOf } from "../src/agent/hooks.ts";
import { Sessions } from "../src/agent/session.ts";
import { makeRepo } from "./helpers.ts";

// Codex's edits: `apply_patch` with its own patch format. The first patch is the one Codex 0.167
// sent when asked to add sub() to math.js and create hello.js.

const MATH = "export function add(a, b) {\n  return a + b;\n}\n";
const REAL = "*** Begin Patch\n*** Update File: math.js\n@@\n+export function sub(a, b) {\n+  return a - b;\n+}\n*** Add File: hello.js\n+export function hello() {\n+  return 'hi';\n+}\n*** End Patch";
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const edits = (command: string, cwd = "/repo") => editsOf({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "apply_patch", cwd, tool_input: { command } });

test("Codex patch: each file it changes, with paths from the folder Codex runs in", () => {
  const [math, hello] = edits(REAL);
  assert.equal(math!.path, resolve("/repo", "math.js"));
  assert.equal(contentAfter(math!, MATH), `${MATH}export function sub(a, b) {\n  return a - b;\n}\n`, "a hunk with nothing to find adds at the end, before the final newline");
  assert.equal(hello!.path, resolve("/repo", "hello.js"));
  assert.equal(contentAfter(hello!, ""), "export function hello() {\n  return 'hi';\n}\n", "a new file: its lines");
});

test("Codex patch: hunks replace the lines they name, after the line @@ points to", () => {
  const file = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n";
  const [edit] = edits(patch("*** Update File: x.js", "@@ function b() {", "-  return 1;", "+  return 2;"));
  assert.equal(contentAfter(edit!, file), "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n", "b's line, not a's");
  const [two] = edits(patch("*** Update File: x.js", "@@", " function a() {", "-  return 1;", "+  return 3;", "@@", " function b() {", "-  return 1;", "+  return 4;"));
  assert.equal(contentAfter(two!, file), "function a() {\n  return 3;\n}\n\nfunction b() {\n  return 4;\n}\n", "two hunks, in order");
});

test("Codex patch: whole lines only, like Codex, so a } inside a line isn't a match", () => {
  const file = "if (x) {\n  run();\n  }\n}\n";
  const [edit] = edits(patch("*** Update File: x.js", "@@", " }", "+// end"));
  assert.equal(contentAfter(edit!, file), "if (x) {\n  run();\n  }\n}\n// end\n", "the line that is }, after the indented one");
  const [spaces] = edits(patch("*** Update File: x.js", "@@", "-  run();   ", "+  go();"));
  assert.equal(contentAfter(spaces!, file), "if (x) {\n  go();\n  }\n}\n", "trailing spaces don't stop a match");
});

test("Codex patch: a hunk that doesn't fit the file gives nothing, and deletes and moves are still files it changed", () => {
  const [missing] = edits(patch("*** Update File: x.js", "@@", "-not in the file", "+anything"));
  assert.equal(contentAfter(missing!, MATH), undefined);
  const files = edits(patch("*** Delete File: old.js", "*** Update File: a.js", "*** Move to: b.js", "@@", "-x", "+y"), "/r");
  assert.deepEqual(files.map((f) => f.path), ["old.js", "a.js", "b.js"].map((f) => resolve("/r", f)));
  assert.equal(contentAfter(files[0]!, "x\n"), undefined, "a deleted file has no content after");
  assert.deepEqual(edits("*** Begin Patch\r\n*** Add File: w.js\r\n+let a;\r\n*** End Patch").map((f) => contentAfter(f, "")), ["let a;\n"], "Windows line endings");
});

test("Codex session: the reuse note before a patch, the new problem after it, and every file on the card", async () => {
  const root = await makeRepo({
    "index.js": "export function load(url) {\n  return fetch(url);\n}\n",
    "time.js": "export function timeAgo(date) {\n  const s = Math.floor((Date.now() - date) / 1000);\n  if (s < 60) return `${s}s ago`;\n  return `${Math.floor(s / 60)}m ago`;\n}\n",
  });
  const sessions = new Sessions(root);
  const hook = async (event: string, extra: object = {}) => {
    const reply = await sessions.handle({ hook_event_name: event, session_id: "codex-1", cwd: root, agent: "codex", ...extra });
    return reply.stdout ? JSON.parse(reply.stdout) : undefined;
  };
  await hook("SessionStart");
  const command = patch(
    "*** Update File: index.js", "@@", "+export function save(x) {", "+  try {", "+    db.put(x);", "+  } catch (e) {}", "+}",
    "*** Add File: ui/ago.js", "+export function since(when) {", "+  const s = Math.floor((Date.now() - when) / 1000);", "+  if (s < 60) return `${s}s ago`;", "+  return `${Math.floor(s / 60)}m ago`;", "+}",
  );
  const before = await hook("PreToolUse", { tool_name: "apply_patch", tool_input: { command } });
  assert.match(before.hookSpecificOutput.additionalContext, /`since`: `timeAgo` in time\.js:1/, "the new file's copy of timeAgo, seen before it's written");
  await writeFile(join(root, "index.js"), `export function load(url) {\n  return fetch(url);\n}\nexport function save(x) {\n  try {\n    db.put(x);\n  } catch (e) {}\n}\n`);
  await mkdir(join(root, "ui"), { recursive: true });
  await writeFile(join(root, "ui/ago.js"), "export function since(when) {\n  const s = Math.floor((Date.now() - when) / 1000);\n  if (s < 60) return `${s}s ago`;\n  return `${Math.floor(s / 60)}m ago`;\n}\n");
  const after = await hook("PostToolUse", { tool_name: "apply_patch", tool_input: { command }, tool_response: "Success." });
  assert.match(after.hookSpecificOutput.additionalContext, /^Attentry: this edit added 1 problem:\nindex\.js:7 warning attentry\/empty-catch/);
  assert.equal((await sessions.status())?.agent, "codex", "the panel shows the task under Codex");
  const stop = await hook("Stop", { stop_hook_active: false });
  assert.match(stop.systemMessage, /- Changed: 2 files \(index\.js, ui\/ago\.js\)/, "one patch, two files on the card");
});
