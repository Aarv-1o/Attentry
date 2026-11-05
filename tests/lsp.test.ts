import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { backgroundRunning } from "../src/daemon/client.ts";
import { makeRepo, stopBackground } from "./helpers.ts";

// Talks to `attentry lsp` the way an editor does: JSON-RPC messages with Content-Length headers.
function startServer() {
  // ATTENTRY_LSP_BUNDLE=editors/vscode/dist tests the server as the extension ships it.
  // Absolute: the background Attentry it starts runs from another folder.
  const bundle = process.env.ATTENTRY_LSP_BUNDLE && resolve(process.env.ATTENTRY_LSP_BUNDLE);
  // The flags VS Code adds when it starts a language server.
  const flags = ["lsp", "--stdio", `--clientProcessId=${process.pid}`];
  const args = bundle ? [join(bundle, "server.mjs"), ...flags] : ["--import", "tsx", "src/cli/bin.ts", ...flags];
  const env = bundle ? { ...process.env, ATTENTRY_WASM_DIR: join(bundle, "wasm") } : process.env;
  const child = spawn(process.execPath, args, { cwd: join(import.meta.dirname, ".."), env });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map<number, (result: unknown) => void>();
  const notes: { method: string; params: any }[] = [];
  const waiters: { test: (n: { method: string; params: any }) => boolean; done: (p: any) => void }[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())![1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
      buffer = buffer.subarray(end + 4 + length);
      if ("id" in message && pending.has(message.id)) pending.get(message.id)!(message.result);
      else if (message.method) {
        notes.push(message);
        for (const w of [...waiters]) if (w.test(message)) waiters.splice(waiters.indexOf(w), 1), w.done(message.params);
      }
    }
  });
  const send = (message: object) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  return {
    request: (method: string, params: unknown) => new Promise<any>((done) => { const id = nextId++; pending.set(id, done); send({ id, method, params }); }),
    notify: (method: string, params: unknown) => send({ method, params }),
    // The next matching notification, or one already received since `from`.
    waitFor: (method: string, match: (p: any) => boolean = () => true, from = 0) => new Promise<any>((done) => {
      const seen = notes.slice(from).find((n) => n.method === method && match(n.params));
      if (seen) return done(seen.params);
      waiters.push({ test: (n) => n.method === method && match(n.params), done });
    }),
    count: () => notes.length,
    stop: () => child.kill(),
  };
}

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args]);
const OLD = `export function load(url) {\n  try {\n    return fetch(url);\n  } catch (e) {}\n}\n`;
const NEW = `${OLD}function calcTax(total) {\n  return total * 0.18;\n}\n`;

test("the language server shows your changes, explains them, and offers safe fixes", { timeout: 60_000 }, async () => {
  // Connecting the agent points its hooks at the built Attentry: build it on a fresh clone.
  const attentry = join(import.meta.dirname, "../dist/attentry.mjs");
  if (!existsSync(attentry)) execFileSync(process.execPath, [join(import.meta.dirname, "../scripts/build.mjs")]);
  const root = await makeRepo({ "index.js": OLD });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  await writeFile(join(root, "index.js"), NEW);
  const uri = pathToFileURL(join(root, "index.js")).href;
  const server = startServer();
  try {
    const init = await server.request("initialize", { processId: null, rootUri: pathToFileURL(root).href, capabilities: {}, initializationOptions: { clientCommands: true } });
    // VS Code's language client registers every server command as an editor command: one with
    // the same name as the extension's own makes the extension fail to start.
    const extension = await readFile(join(import.meta.dirname, "../editors/vscode/src/extension.ts"), "utf8");
    const own = [...extension.matchAll(/registerCommand\("([^"]+)"/g)].map((m) => m[1]);
    assert.ok(own.length >= 3);
    assert.deepEqual(init.capabilities.executeCommandProvider.commands.filter((c: string) => own.includes(c)), []);
    server.notify("initialized", {});
    const status = await server.waitFor("attentry/status", (p) => !p.scanning);
    assert.deepEqual(status.counts, { security: 0, breaks: 0, database: 0, cleanup: 1 });
    assert.equal(status.older, 1, "the old empty catch isn't yours");
    assert.equal(await backgroundRunning(root), true, "read by the background Attentry agents use, not a second copy");
    const { diagnostics } = await server.waitFor("textDocument/publishDiagnostics", (p) => p.uri === uri);
    assert.deepEqual(diagnostics.map((d: any) => [d.code, d.severity, d.tags, d.range.start.line, d.range.end.line, d.message]), [["dead-function", 3, [1], 5, 7, "Dead function: calcTax"]]);

    const hover = await server.request("textDocument/hover", { textDocument: { uri }, position: { line: 6, character: 3 } });
    assert.match(hover.contents.value, /only you see this\n\n`calcTax\(total\)`: it returns `total \* 0\.18`\.\n\n\*\*Dead function: calcTax\.\*\* Code nobody calls/);

    const actions = await server.request("textDocument/codeAction", { textDocument: { uri }, range: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } }, context: { diagnostics } });
    assert.deepEqual(actions.map((a: any) => a.title), [
      "Delete calcTax (nothing uses it)", "Attentry: copy the fix for your agent (dead-function)",
      "Attentry: ignore dead-function here (write the reason after the colon)", "Attentry: not useful (Dead functions)",
    ]);
    assert.deepEqual(actions[0].edit.changes[uri][0].range, { start: { line: 5, character: 0 }, end: { line: 8, character: 0 } });
    assert.match(actions[1].command.arguments[0], /^`calcTax\(total\)`: it returns/);

    const list = await server.request("attentry/findings", {});
    assert.deepEqual(list.items.map((i: any) => [i.part, i.severity, i.file, i.line, i.does]), [["cleanup", "info", "index.js", 6, "`calcTax(total)`: it returns `total * 0.18`."]]);
    assert.equal(list.older, 1);
    assert.match(await server.request("attentry/report", { format: "person" }), /^Clean-up \(1\)\n {2}index\.js:6/);
    // The editor's full report: rendered Markdown, links naming each file in full.
    const md = await server.request("attentry/report", { format: "markdown" });
    assert.match(md, /^# Attentry report: /);
    assert.ok(md.includes(`](${pathToFileURL(root).href}/index.js#L6)`), "links open the file at its line");
    assert.match(await server.request("attentry/explain", { id: list.items[0].id }), /## Dead functions \(1\)/);

    const before = server.count();
    await server.request("workspace/executeCommand", { command: "attentry.server.toggleShow", arguments: [] });
    const whole = await server.waitFor("textDocument/publishDiagnostics", (p) => p.uri === uri, before);
    assert.deepEqual(whole.diagnostics.map((d: any) => [d.code, d.severity]), [["empty-catch", 2], ["dead-function", 3]], "warnings before info");

    // The agent section: not connected, connect it, change the mode.
    assert.deepEqual(await server.request("attentry/agent", {}), { hooks: "missing", mcp: "missing", mode: "suggest", live: null });
    await server.request("workspace/executeCommand", { command: "attentry.server.connectAgent", arguments: [] });
    await server.request("workspace/executeCommand", { command: "attentry.server.setMode", arguments: ["block"] });
    assert.deepEqual(await server.request("attentry/agent", {}), { hooks: "connected", mcp: "missing", mode: "block", live: null });

    // Auto-check off: the status says so.
    const mark = server.count();
    await server.request("workspace/executeCommand", { command: "attentry.server.toggleAuto", arguments: [] });
    assert.equal((await server.waitFor("attentry/status", (p) => !p.scanning, mark)).autoScan, false);
  } finally {
    server.stop();
    await stopBackground(root); // the language server's findings came from it
  }
});

test("file URIs keep the editor's spelling of the folder (Windows: file:///d%3A/...)", async () => {
  const { uriOf } = await import("../src/lsp/convert.ts");
  assert.equal(uriOf("file:///d%3A/attentry/Travscape-main", "agents/my file.py"), "file:///d%3A/attentry/Travscape-main/agents/my%20file.py");
  assert.equal(uriOf("file:///home/me/repo/", "a.ts"), "file:///home/me/repo/a.ts");
});
