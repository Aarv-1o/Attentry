import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { codexHome, codexHooks, installCodex, refreshCodex } from "../src/agent/codex.ts";
import { noteHeard } from "../src/agent/heard.ts";
import { fakeAgent, makeRepo, withHome } from "./helpers.ts";

// Codex: the extension's codex/ marketplace with attentry-hooks (fixed forever) and attentry (the
// tools, versioned), installed with Codex's own commands. A fake `codex` answers, with its own
// CODEX_HOME, and each test has its own home folder (Attentry writes to ~/.attentry), so the
// person's real Codex and Attentry are never touched.

const run = promisify(execFile);
const PLUGINS = join(import.meta.dirname, "../codex-plugin");

// ---- The plugins' files ----

// Codex asks every user to trust attentry-hooks again when any byte in it changes, so it never
// does. Changing one of these files means everyone who connected Codex approves the hooks again.
test("attentry-hooks never changes: these exact files", async () => {
  const root = join(PLUGINS, "attentry-hooks");
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  const hashes = Object.fromEntries(await Promise.all(files.sort().map(async (f) => [relative(root, f).split(sep).join("/"), createHash("sha256").update(await readFile(f)).digest("hex").slice(0, 16)])));
  assert.deepEqual(hashes, {
    ".codex-plugin/plugin.json": "7e9c8900c550cf6c",
    "hooks/hooks.json": "81cf196537ecb382",
    "launch.mjs": "99371e64bba20a69",
  });
});

test("attentry-hooks: every event, each through the launcher", async () => {
  const each = (matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/launch.mjs" hook codex' }] }];
  const edits = "apply_patch|Edit|Write";
  assert.deepEqual(JSON.parse(await readFile(join(PLUGINS, "attentry-hooks/hooks/hooks.json"), "utf8")), {
    hooks: { SessionStart: each(), UserPromptSubmit: each(), PreToolUse: each(edits), PostToolUse: each(edits), Stop: each() },
  });
  assert.equal(JSON.parse(await readFile(join(PLUGINS, "attentry-hooks/.codex-plugin/plugin.json"), "utf8")).version, "1.0.0");
});

// A stand-in for Attentry: says what it was started with.
const FAKE_BUILD = `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), flags: process.execArgv, cwd: process.cwd() }));\n`;
// A home folder with that stand-in, named in ~/.attentry/build.json as the extension would.
async function inHome(pointed: boolean) {
  const home = await makeRepo({ "build.mjs": FAKE_BUILD });
  if (pointed) {
    await mkdir(join(home, ".attentry"), { recursive: true });
    await writeFile(join(home, ".attentry", "build.json"), JSON.stringify({ entry: join(home, "build.mjs") }));
  }
  return { env: { ...process.env, HOME: home, USERPROFILE: home } };
}

test("the launcher runs the Attentry the extension names, with the hook's arguments", async () => {
  const { env } = await inHome(true);
  const { stdout } = await run(process.execPath, [join(PLUGINS, "attentry-hooks/launch.mjs"), "hook", "codex"], { env });
  assert.deepEqual(JSON.parse(stdout).args, ["hook", "codex"]);
});

test("the launcher without the extension: says what to do, and fails without blocking Codex (exit 1)", async () => {
  const { env } = await inHome(false);
  await assert.rejects(run(process.execPath, [join(PLUGINS, "attentry-hooks/launch.mjs"), "hook", "codex"], { env }), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /open your editor with the Attentry extension once/);
    return true;
  });
});

test("the MCP server: the same Attentry, started where Codex starts it, without the loader's own flags", async () => {
  const { env } = await inHome(true);
  const server = JSON.parse(await readFile(join(PLUGINS, "attentry/.mcp.json"), "utf8")).mcpServers.attentry;
  assert.equal(server.cwd, undefined, "no cwd: Codex starts it in the project, which is the repo Attentry checks");
  const project = await makeRepo({});
  const { stdout } = await run(server.command, server.args, { env, cwd: project });
  // Flags carried over would start the loader again for the background Attentry, and so on.
  assert.deepEqual(JSON.parse(stdout), { args: ["mcp"], flags: [], cwd: project });
});

// ---- Connecting ----

// The extension's folder, with a space in it as a home folder can have: `codex` gets it quoted.
const extension = async (version: string) => join(await makeRepo({
  "my extensions/claude/.claude-plugin/marketplace.json": "{}",
  "my extensions/codex/.agents/plugins/marketplace.json": "{}",
  "my extensions/codex/attentry/.codex-plugin/plugin.json": JSON.stringify({ name: "attentry", version }),
}), "my extensions");
const listed = (version: string) => ({ installed: [{ pluginId: "attentry-hooks@attentry", enabled: true, version: "1.0.0" }, { pluginId: "attentry@attentry", enabled: true, version }] });
const ADD = (home: string) => ["plugin list --json", "plugin marketplace remove attentry", `plugin marketplace add ${home}`, "plugin add attentry-hooks@attentry", "plugin add attentry@attentry"];
const pointer = async (me: string) => JSON.parse(await readFile(join(me, ".attentry/build.json"), "utf8")).entry;

test("codexHome: the Codex marketplace beside the Claude Code one, when the extension carries it", async () => {
  const root = await extension("1.0.0");
  assert.equal(codexHome(join(root, "claude")), join(root, "codex"));
  assert.equal(codexHome(await makeRepo({ "claude/.claude-plugin/marketplace.json": "{}" })), undefined, "an older extension: no Codex plugin");
});

test("Connect Codex installs both plugins from this extension, and points them at its Attentry", () => withHome({}, async (me) => {
  const root = await extension("1.0.0");
  using codex = await fakeAgent("codex", { installed: [] });
  assert.deepEqual(await installCodex(join(root, "codex"), await makeRepo({})), { ok: true });
  assert.deepEqual(await codex.calls(), ADD(join(root, "codex")), "the marketplace removed first: an update moves the extension's folder");
  assert.equal(await pointer(me), join(root, "claude", "attentry", "dist", "attentry.mjs"));
}));

test("Connect Codex without the `codex` command: says so, with the commands to run", () => withHome({}, async () => {
  const home = join(await extension("1.0.0"), "codex");
  using _codex = await fakeAgent("codex", {});
  process.env.ATTENTRY_CODEX = join(home, "no-such-codex");
  const result = await installCodex(home, await makeRepo({}));
  assert.ok(!result.ok);
  assert.match(result.reason, /Codex's `codex` command isn't installed|no-such-codex/);
  assert.equal(result.command, `codex plugin marketplace add "${home}" && codex plugin add attentry-hooks@attentry && codex plugin add attentry@attentry`);
}));

test("when the editor starts: the plugins point at this extension's Attentry, and an older tools plugin is updated", () => withHome({}, async (me) => {
  const root = await extension("1.1.0");
  const home = join(root, "codex");
  const folder = await makeRepo({});
  {
    using codex = await fakeAgent("codex", listed("1.1.0"));
    assert.deepEqual(await refreshCodex(home, folder), { installed: true, enabled: true, version: "1.1.0" });
    assert.deepEqual(await codex.calls(), ["plugin list --json"], "already this version");
    assert.equal(await pointer(me), join(root, "claude", "attentry", "dist", "attentry.mjs"), "an update moved the extension: pointed at the new one");
  }
  {
    using codex = await fakeAgent("codex", { installed: [] });
    assert.deepEqual(await refreshCodex(home, folder), { installed: false });
    assert.deepEqual(await codex.calls(), ["plugin list --json"], "not installed: Connect is the person's choice");
  }
  {
    using codex = await fakeAgent("codex", listed("1.0.0"));
    await refreshCodex(home, folder);
    assert.deepEqual(await codex.calls(), ["plugin list --json", ...ADD(home), "plugin list --json"]);
  }
}));

// ---- Whether Codex runs the hooks ----

// Codex's own list of sessions, newest activity `at`.
async function codexSession(codexDir: string, at: number) {
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "session_index.jsonl"), `${JSON.stringify({ id: "1", thread_name: "older", updated_at: "2026-01-01T00:00:00Z" })}\n${JSON.stringify({ id: "2", thread_name: "fix it", updated_at: new Date(at).toISOString() })}\n`);
}

test("Codex's hooks: waiting until a session, running once Codex ran them, and still trusted after an update", () => withHome({}, async (me) => {
  const extensionHome = join(await extension("1.0.0"), "codex");
  {
    using _codex = await fakeAgent("codex", { installed: [] });
    await installCodex(extensionHome, me);
    assert.equal(await codexHooks(), "waiting", "connected, no Codex session since");
    await codexSession(process.env.CODEX_HOME!, Date.now() + 1000);
    assert.equal(await codexHooks(), "approve", "a session ran, and the hooks didn't: not trusted yet");
    await noteHeard("codex");
    assert.equal(await codexHooks(), "running");
  }
  using _codex = await fakeAgent("codex", listed("1.0.0"));
  await codexSession(process.env.CODEX_HOME!, Date.now() + 1000);
  await installCodex(extensionHome, me);
  assert.equal(await codexHooks(), "running", "the hooks plugin was already in: the same one, still trusted");
}));
