import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { addressFor } from "../src/daemon/address.ts";
import { agentStatus } from "../src/daemon/client.ts";
import { makeRepo } from "./helpers.ts";

const run = promisify(execFile);
const DETRON = join(import.meta.dirname, "../src/cli/bin.ts");

// One hook call, the way Claude Code makes it: a new process, the event as JSON on stdin.
async function hook(root: string, input: object) {
  const child = run(process.execPath, ["--import", "tsx", DETRON, "hook", "claude"], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  child.child.stdin!.end(JSON.stringify({ session_id: "s1", cwd: root, ...input }));
  const { stdout } = await child;
  return stdout ? JSON.parse(stdout) : undefined;
}

// Asks the background Detron to stop (a build it doesn't know makes it step aside).
const stop = (root: string) => new Promise<void>((done) => {
  const socket = createConnection(addressFor(root), () => socket.write(`${JSON.stringify({ kind: "ping", build: "test-cleanup" })}\n`));
  socket.on("data", () => socket.end());
  socket.on("close", () => done());
  socket.on("error", () => done());
});

const START = `export function load(url) {\n  try {\n    return fetch(url);\n  } catch (e) {}\n}\n`;

test("hooks share one background Detron that remembers the task between calls", { timeout: 60_000 }, async () => {
  const root = await makeRepo({ "index.js": START });
  try {
    assert.equal(await agentStatus(root), undefined, "no agent yet: nothing is started just to ask");
    const hello = await hook(root, { hook_event_name: "SessionStart", source: "startup" });
    assert.match(hello.hookSpecificOutput.additionalContext, /^Detron is on for detron-\w+ \(1 file, suggest mode\): /, "one line, so the agent knows Detron is on");
    const file = join(root, "index.js");
    assert.equal(await hook(root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file } }), undefined);
    await writeFile(file, `${START}export function save(x) {\n  try {\n    db.put(x);\n  } catch (e) {}\n}\n`);
    const started = Date.now();
    const told = await hook(root, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } });
    const took = Date.now() - started;
    assert.match(told.hookSpecificOutput.additionalContext, /index\.js:9 warning detron\/empty-catch/);
    const live = await agentStatus(root);
    assert.deepEqual({ ...live, lastEditAt: undefined }, {
      edits: 1, added: 1, untilCheckIn: 9, checkInEvery: 10, lastEditAt: undefined, files: 1,
      tests: { state: "not run", text: "not run yet (they run at the first check-in)" },
    }, "the editor sees the task");
    const end = await hook(root, { hook_event_name: "Stop", stop_hook_active: false });
    assert.match(end.systemMessage, /^Detron change card\n- Changed: 1 file \(index\.js\)\n- Problems: 1 added \(1 will break\)\n[^]*- Tests: none found/, "the task survived across hook processes");
    console.log(`# after-edit hook took ${took}ms (process start included)`);
  } finally {
    await stop(root);
  }
});

test("something else holding the background Detron's address is never believed", { timeout: 60_000 }, async () => {
  const root = await makeRepo({ "index.js": START });
  const lie = { reply: { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "not Detron" } })}\n`, exitCode: 0 } };
  const impostor = createServer((socket) => socket.on("data", () => socket.end(`${JSON.stringify(lie)}\n`)));
  await new Promise<void>((done) => impostor.listen(addressFor(root), done));
  try {
    const hello = await hook(root, { hook_event_name: "SessionStart", source: "startup" });
    assert.match(hello.hookSpecificOutput.additionalContext, /^Detron is on for /, "answered by Detron itself, without the background one");
  } finally {
    await new Promise((done) => impostor.close(done));
  }
});
