import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { addressFor } from "../src/daemon/address.ts";
import { handleMessage } from "../src/mcp/server.ts";
import { makeRepo } from "./helpers.ts";
import { REPO } from "./agentRepo.ts";

test("protocol: initialize, the tool list, ping, and errors an agent can read", async () => {
  const never = async () => ({ text: "" });
  const init = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, never)) as any;
  assert.equal(init.result.protocolVersion, "2025-03-26", "the agent's version, when Detron knows it");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  const newer = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }, never)) as any;
  assert.equal(newer.result.protocolVersion, "2025-06-18", "otherwise the newest Detron speaks");
  const list = (await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, never)) as any;
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["find_existing", "check", "explain"]);
  assert.deepEqual(await handleMessage({ jsonrpc: "2.0", id: 4, method: "ping" }, never), { jsonrpc: "2.0", id: 4, result: {} });
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, never), undefined, "notifications get no reply");
  assert.equal(((await handleMessage({ jsonrpc: "2.0", id: 5, method: "resources/list" }, never)) as any).error.code, -32601);
  assert.equal(((await handleMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }, never)) as any).error.code, -32602);
  const broken = async () => { throw new Error("disk full"); };
  const failed = (await handleMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "check", arguments: {} } }, broken)) as any;
  assert.deepEqual(failed.result, { content: [{ type: "text", text: "Detron failed: disk full" }], isError: true }, "a failed tool is a result, not a dropped connection");
});

const DETRON = join(import.meta.dirname, "../src/cli/bin.ts");
const run = promisify(execFile);
const stop = (root: string) => new Promise<void>((done) => {
  const socket = createConnection(addressFor(root), () => socket.write(`${JSON.stringify({ kind: "ping", build: "test-cleanup" })}\n`));
  socket.on("data", () => socket.end());
  socket.on("close", () => done());
  socket.on("error", () => done());
});

test("detron mcp over stdio shares the background Detron with hooks: the same task", { timeout: 60_000 }, async () => {
  const root = await makeRepo({ ...REPO, "src/api.js": "export const x = 1;\n" });
  const cwd = join(import.meta.dirname, "..");
  let mcp: ReturnType<typeof spawn> | undefined;
  try {
    // An agent session, through the hook process the way Claude Code runs it.
    const hook = async (input: object) => {
      const child = run(process.execPath, ["--import", "tsx", DETRON, "hook", "claude"], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
      child.child.stdin!.end(JSON.stringify({ session_id: "s1", cwd: root, ...input }));
      await child;
    };
    await hook({ hook_event_name: "SessionStart" });
    await writeFile(join(root, "src/api.js"), "export function load(url) {\n  try {\n    return fetch(url);\n  } catch (e) {}\n}\n");
    await hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "src/api.js") } });

    mcp = spawn(process.execPath, ["--import", "tsx", DETRON, "mcp", root], { cwd });
    let buffer = "";
    const replies = new Map<number, (m: any) => void>();
    mcp.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        replies.get(message.id)?.(message);
      }
    });
    let id = 0;
    const ask = (method: string, params: object = {}) => new Promise<any>((done) => {
      replies.set(++id, done);
      mcp!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    assert.equal((await ask("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "detron");
    const checked = await ask("tools/call", { name: "check", arguments: { files: ["src/api.js"] } });
    assert.match(checked.result.content[0].text, /src\/api\.js:4 warning detron\/empty-catch: .+ \(new in this task\)/, "the task the hooks started");
    mcp.stdin!.end();
    await new Promise((done) => mcp!.on("close", done));
  } finally {
    mcp?.kill(); // a failed assertion must not leave it waiting for input
    await stop(root);
  }
});
