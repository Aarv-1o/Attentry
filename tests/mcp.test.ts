import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { addressFor } from "../src/daemon/address.ts";
import { makeRepo } from "./helpers.ts";
import { REPO } from "./agentRepo.ts";

const DETRON = join(import.meta.dirname, "../src/cli/bin.ts");
const CWD = join(import.meta.dirname, "..");
const run = promisify(execFile);
const stop = (root: string) => new Promise<void>((done) => {
  const socket = createConnection(addressFor(root), () => socket.write(`${JSON.stringify({ kind: "ping", build: "test-cleanup" })}\n`));
  socket.on("data", () => socket.end());
  socket.on("close", () => done());
  socket.on("error", () => done());
});

// `detron mcp` over stdio, the way an agent runs it: send a request, wait for its reply.
function startMcp(root: string) {
  const mcp: ChildProcess = spawn(process.execPath, ["--import", "tsx", DETRON, "mcp", root], { cwd: CWD });
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
    mcp.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const call = async (name: string, args: unknown) => (await ask("tools/call", { name, arguments: args })).result;
  const close = async () => {
    mcp.stdin!.end();
    await new Promise((done) => mcp.on("close", done));
  };
  return { mcp, ask, call, close, raw: (line: string) => mcp.stdin!.write(`${line}\n`) };
}

test("detron mcp: both protocol eras, and wrong calls come back as errors the agent can fix", { timeout: 60_000 }, async () => {
  const root = await makeRepo({ "src/time.js": 'export function timeAgo(d) {\n  return "just now";\n}\n' });
  const server = startMcp(root);
  try {
    const init = await server.ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.serverInfo.name, "detron");
    assert.match(init.result.instructions, /find_existing/);
    const tools = (await server.ask("tools/list")).result.tools;
    assert.deepEqual(tools.map((t: any) => t.name), ["find_existing", "check", "explain"]);
    assert.ok(tools.every((t: any) => t.annotations.readOnlyHint), "agents may call them without asking: they change nothing");

    // Malformed lines don't stop the server: the next request is still answered.
    server.raw("null");
    server.raw("not json {");
    const missing = await server.call("find_existing", {});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Give `query`/);
    assert.match((await server.call("check", { files: "src/time.js" })).content[0].text, /files: .*expected array/);
    assert.match((await server.call("explain", { location: "src/time.js" })).content[0].text, /file:line/);
    assert.equal((await server.call("find_existing", { query: "x".repeat(501) })).isError, true, "inputs are capped");
    const found = await server.call("find_existing", { query: "time ago" });
    assert.equal(found.isError, false);
    assert.match(found.content[0].text, /timeAgo\(d\)` in src\/time\.js:1/);
    await server.close();
    // A 2026-07-28 client: no handshake, the version on every request. A connection is one era.
    const modern = startMcp(root);
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
    assert.ok((await modern.ask("server/discover", { _meta: meta })).result.supportedVersions.includes("2026-07-28"));
    assert.match((await modern.ask("tools/call", { name: "find_existing", arguments: { query: "time ago" }, _meta: meta })).result.content[0].text, /timeAgo/);
    await modern.close();
  } finally {
    server.mcp.kill(); // a failed assertion must not leave it waiting for input
    await stop(root);
  }
});

test("detron mcp over stdio shares the background Detron with hooks: the same task", { timeout: 60_000 }, async () => {
  const root = await makeRepo({ ...REPO, "src/api.js": "export const x = 1;\n" });
  let server: ReturnType<typeof startMcp> | undefined;
  try {
    // An agent session, through the hook process the way Claude Code runs it.
    const hook = async (input: object) => {
      const child = run(process.execPath, ["--import", "tsx", DETRON, "hook", "claude"], { cwd: CWD, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
      child.child.stdin!.end(JSON.stringify({ session_id: "s1", cwd: root, ...input }));
      await child;
    };
    await hook({ hook_event_name: "SessionStart" });
    await writeFile(join(root, "src/api.js"), "export function load(url) {\n  try {\n    return fetch(url);\n  } catch (e) {}\n}\n");
    await hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "src/api.js") } });

    server = startMcp(root);
    assert.equal((await server.ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result.serverInfo.name, "detron");
    const checked = await server.call("check", { files: ["src/api.js"] });
    assert.match(checked.content[0].text, /src\/api\.js:4 warning detron\/empty-catch: .+ \(new in this task\)/, "the task the hooks started");
    await server.close();
  } finally {
    server?.mcp.kill();
    await stop(root);
  }
});
