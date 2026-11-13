import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { codexHome, codexHooks, installCodex, noteHeard, refreshCodex } from "../src/agent/codex.ts";
import { fakeAgent, makeRepo, withHome } from "./helpers.ts";

// Connecting Codex: the extension's codex/ marketplace, installed with Codex's own commands. A fake
// `codex` answers, with its own CODEX_HOME, and each test has its own home folder (Attentry notes
// the install in ~/.attentry), so the person's real Codex and Attentry are never touched.

// The extension's folder, with a space in it as a home folder can have: `codex` gets it quoted.
const extension = async (version: string) => join(await makeRepo({
  "my extensions/claude/.claude-plugin/marketplace.json": "{}",
  "my extensions/codex/.agents/plugins/marketplace.json": "{}",
  "my extensions/codex/attentry/.codex-plugin/plugin.json": JSON.stringify({ name: "attentry", version }),
}), "my extensions");
const listed = (version: string) => ({ installed: [{ pluginId: "attentry@attentry", enabled: true, version }] });
const ADD = (home: string) => ["plugin marketplace remove attentry", `plugin marketplace add ${home}`, "plugin add attentry@attentry"];

test("codexHome: the Codex marketplace beside the Claude Code one, when the extension carries it", async () => {
  const root = await extension("1.0.0");
  assert.equal(codexHome(join(root, "claude")), join(root, "codex"));
  assert.equal(codexHome(await makeRepo({ "claude/.claude-plugin/marketplace.json": "{}" })), undefined, "an older extension: no Codex plugin");
});

test("Connect Codex points the marketplace at this extension and installs the plugin from it", () => withHome({}, async () => {
  const home = join(await extension("1.0.0"), "codex");
  using codex = await fakeAgent("codex", { installed: [] });
  assert.deepEqual(await installCodex(home, await makeRepo({})), { ok: true });
  assert.deepEqual(await codex.calls(), ADD(home), "removed first: an update moves the extension's folder");
}));

test("Connect Codex without the `codex` command: says so, with the commands to run", () => withHome({}, async () => {
  const home = join(await extension("1.0.0"), "codex");
  using _codex = await fakeAgent("codex", {});
  process.env.ATTENTRY_CODEX = join(home, "no-such-codex");
  const result = await installCodex(home, await makeRepo({}));
  assert.ok(!result.ok);
  assert.match(result.reason, /Codex's `codex` command isn't installed|no-such-codex/);
  assert.equal(result.command, `codex plugin marketplace add "${home}" && codex plugin add attentry@attentry`);
}));

test("when the editor starts, an installed plugin older than the extension's is updated; nothing else is touched", () => withHome({}, async () => {
  const home = join(await extension("1.1.0"), "codex");
  const folder = await makeRepo({});
  {
    using codex = await fakeAgent("codex", listed("1.1.0"));
    assert.deepEqual(await refreshCodex(home, folder), { installed: true, enabled: true, version: "1.1.0" });
    assert.deepEqual(await codex.calls(), ["plugin list --json"], "already this version");
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

// Codex's own list of sessions, newest activity `at`.
async function codexSession(codexDir: string, at: number) {
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "session_index.jsonl"), `${JSON.stringify({ id: "1", thread_name: "older", updated_at: "2026-01-01T00:00:00Z" })}\n${JSON.stringify({ id: "2", thread_name: "fix it", updated_at: new Date(at).toISOString() })}\n`);
}

test("Codex's hooks: waiting until a session, then running once Codex ran them, or waiting for the person to trust them", () => withHome({}, async (me) => {
  const extensionHome = join(await extension("1.0.0"), "codex");
  using _codex = await fakeAgent("codex", { installed: [] });
  const codexDir = process.env.CODEX_HOME!;
  await installCodex(extensionHome, me);
  assert.equal(await codexHooks(), "waiting", "connected, no Codex session since");
  await codexSession(codexDir, Date.now() + 1000);
  assert.equal(await codexHooks(), "approve", "a session ran, and the hooks didn't: not trusted yet");
  await noteHeard();
  assert.equal(await codexHooks(), "running");
  await codexSession(codexDir, Date.now() - 1000); // the last session was before the update
  await installCodex(extensionHome, me);
  assert.equal(await codexHooks(), "waiting", "an update: heard from again only once trusted again");
}));
