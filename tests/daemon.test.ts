import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { addressFor } from "../src/daemon/address.ts";
import { agentStatus } from "../src/daemon/client.ts";
import { findTests } from "../src/agent/tests.ts";
import { allowTests, testsAllowed } from "../src/agent/trust.ts";
import { makeRepo, stopBackground, withClaudeSettings } from "./helpers.ts";

const run = promisify(execFile);
const ATTENTRY = join(import.meta.dirname, "../src/cli/bin.ts");

// One hook call, the way Claude Code makes it: a new process, the event as JSON on stdin.
async function hook(root: string, input: object) {
  const child = run(process.execPath, ["--import", "tsx", ATTENTRY, "hook", "claude"], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  child.child.stdin!.end(JSON.stringify({ session_id: "s1", cwd: root, ...input }));
  const { stdout } = await child;
  return stdout ? JSON.parse(stdout) : undefined;
}

const START = `export function load(url) {\n  try {\n    return fetch(url);\n  } catch (e) {}\n}\n`;

test("hooks share one background Attentry that remembers the task between calls", { timeout: 60_000 }, async () => {
  const root = await makeRepo({ "index.js": START });
  try {
    assert.equal(await agentStatus(root), undefined, "no agent yet: nothing is started just to ask");
    const hello = await hook(root, { hook_event_name: "SessionStart", source: "startup" });
    assert.match(hello.hookSpecificOutput.additionalContext, /^Attentry is on for attentry-\w+ \(1 file, suggest mode\): /, "one line, so the agent knows Attentry is on");
    const file = join(root, "index.js");
    assert.equal(await hook(root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file } }), undefined);
    await writeFile(file, `${START}export function save(x) {\n  try {\n    db.put(x);\n  } catch (e) {}\n}\n`);
    const started = Date.now();
    const told = await hook(root, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } });
    const took = Date.now() - started;
    assert.match(told.hookSpecificOutput.additionalContext, /index\.js:9 warning attentry\/empty-catch/);
    const live = await agentStatus(root);
    assert.deepEqual({ ...live, lastEditAt: undefined }, {
      edits: 1, added: 1, untilCheckIn: 9, checkInEvery: 10, lastEditAt: undefined, files: 1,
      tests: { state: "not run", text: "not run yet (they run at the first check-in)" }, agent: "claude",
    }, "the editor sees the task, as Claude Code's when the hook doesn't name its agent");
    const end = await hook(root, { hook_event_name: "Stop", stop_hook_active: false });
    assert.match(end.systemMessage, /^Attentry change card\n- Changed: 1 file \(index\.js\)\n- Problems: 1 added \(1 will break\)\n[^]*- Tests: none found/, "the task survived across hook processes");
    console.log(`# after-edit hook took ${took}ms (process start included)`);
  } finally {
    await stopBackground(root);
  }
});

test("something else holding the background Attentry's address is never believed", { timeout: 60_000 }, async () => {
  const root = await makeRepo({ "index.js": START });
  const lie = { reply: { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "not Attentry" } })}\n`, exitCode: 0 } };
  const impostor = createServer((socket) => socket.on("data", () => socket.end(`${JSON.stringify(lie)}\n`)));
  await new Promise<void>((done) => impostor.listen(addressFor(root), done));
  try {
    const hello = await hook(root, { hook_event_name: "SessionStart", source: "startup" });
    assert.match(hello.hookSpecificOutput.additionalContext, /^Attentry is on for /, "answered by Attentry itself, without the background one");
  } finally {
    await new Promise((done) => impostor.close(done));
  }
});

test("one folder spelled two ways (VS Code's d: and a terminal's D:) shares one background Attentry", { skip: process.platform !== "win32" && "drive letters are Windows only" }, async () => {
  const root = await makeRepo({ "index.js": START, "package.json": JSON.stringify({ scripts: { test: "node -e 0" } }) });
  const other = root.replace(/^[a-z]:/i, (drive) => (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()));
  assert.notEqual(other, root);
  assert.equal(addressFor(other), addressFor(root));
  await withClaudeSettings({}, async () => {
    await allowTests(root, await findTests(root, undefined));
    assert.equal(await testsAllowed(other, await findTests(other, undefined)), true, "tests allowed for one spelling are allowed for both");
  });
});
