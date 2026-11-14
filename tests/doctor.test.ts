import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { doctor } from "../src/agent/doctor.ts";
import type { CodexState } from "../src/agent/codex.ts";
import type { PluginState } from "../src/agent/plugin.ts";
import { makeRepo, withClaudeSettings, withHome } from "./helpers.ts";

// Claude Code's answer about its plugins, without running `claude`.
const noPlugin = async (): Promise<PluginState> => ({ installed: false });

test("doctor: the project, git, hooks, mode and MCP, with what to do", async () => {
  const folder = await makeRepo({ "shop/README.md": "", "shop/src/app.ts": "export const a = 1;\n" });
  const project = join(folder, "shop");
  await withClaudeSettings({}, async () => {
    const report = await doctor(folder, noPlugin);
    assert.match(report, /^✓ Project: shop, inside the folder you're in \(1 file Attentry reads\)\n! Git: no/);
    assert.match(report, /! Tests: none found/);
    assert.match(report, /✗ Claude Code: not connected\n {2}→ Click Connect Claude Code in the Attentry sidebar/);
    assert.match(report, /! MCP tools \(find_existing, check, explain, check_plan\): not added/);
  });
  // `claude mcp add --scope local` from the project's folder, pointing at an Attentry that exists.
  const attentry = join(await makeRepo({}), "attentry.mjs");
  await writeFile(attentry, "");
  await withClaudeSettings({ projects: { [project]: { mcpServers: { attentry: { command: "node", args: [attentry, "mcp"] } } } } }, async () => {
    assert.match(await doctor(folder, noPlugin), /✓ MCP tools: added \(Claude Code, for .+shop\)/);
  });
  await withClaudeSettings({ mcpServers: { attentry: { command: "node", args: [join(project, "moved/attentry.mjs"), "mcp"] } } }, async () => {
    assert.match(await doctor(project, noPlugin), /✗ MCP tools: added \(Claude Code, for every folder\), but .+moved[\\/]attentry\.mjs isn't there/);
  });
  await mkdir(join(project, ".git"));
  await withClaudeSettings({}, async () => assert.match(await doctor(project, noPlugin), /✓ Git: yes/));
});

test("doctor: with the plugin, one line for Claude Code, and no folder hooks or MCP to check", async () => {
  const folder = await makeRepo({ "src/app.ts": "export const a = 1;\n" });
  await withClaudeSettings({}, async () => {
    const on = await doctor(folder, async () => ({ installed: true, enabled: true, version: "0.0.14" }));
    assert.match(on, /✓ Claude Code: connected \(the Attentry plugin, 0\.0\.14\)/);
    assert.doesNotMatch(on, /hooks|MCP tools/);
    assert.match(await doctor(folder, async () => ({ installed: true, enabled: false, version: "0.0.14" })), /✗ Claude Code: the Attentry plugin is installed but turned off\n {2}→ Run `claude plugin enable attentry@attentry`/);
  });
  // Connected, then a Claude Code session here (Claude Code's file for it) without a word from the hooks.
  const session = `.claude/projects/${folder.replace(/[^a-zA-Z0-9]/g, "-")}/1b2c.jsonl`;
  await withHome({ ".attentry/claude.json": JSON.stringify({ installedAt: 1 }), [session]: "{}\n" }, async () => {
    const unheard = await doctor(folder, async () => ({ installed: true, enabled: true, version: "0.1.5" }));
    assert.match(unheard, /✗ Claude Code: connected \(the Attentry plugin, 0\.1\.5\), but Claude Code ran here since without running Attentry's hooks\n {2}→ Start a new Claude Code session/);
  });
});

test("doctor: a Codex line for someone who uses Codex, saying whether its hooks run", async () => {
  const folder = await makeRepo({ "src/app.ts": "export const a = 1;\n" });
  const plugin = async (version = "0.1.4"): Promise<CodexState> => ({ installed: true, enabled: true, version });
  await withHome({}, async () => assert.doesNotMatch(await doctor(folder, noPlugin, plugin), /Codex/, "no Codex folder: no line"));
  const session = JSON.stringify({ id: "1", thread_name: "a task", updated_at: "2026-11-13T10:00:00Z" });
  await withHome({ ".codex/session_index.jsonl": "" }, async () => {
    assert.match(await doctor(folder, noPlugin, async () => ({ installed: false })), /! Codex: not connected\n {2}→ Click Connect Codex/);
    assert.match(await doctor(folder, noPlugin, () => plugin()), /✓ Codex: connected \(the Attentry plugin, 0\.1\.4\)\. Codex asks you to trust its hooks when it next starts/);
  });
  // Installed before the last Codex session, and never heard from: the person hasn't trusted the hooks.
  await withHome({ ".codex/session_index.jsonl": `${session}\n`, ".attentry/codex.json": JSON.stringify({ installedAt: Date.parse("2026-11-13T09:00:00Z") }) }, async () => {
    assert.match(await doctor(folder, noPlugin, () => plugin()), /✗ Codex: the Attentry plugin is installed \(0\.1\.4\), but Codex hasn't run its hooks\n {2}→ In Codex, run \/hooks/);
  });
  await withHome({ ".codex/session_index.jsonl": `${session}\n`, ".attentry/codex.json": JSON.stringify({ installedAt: 1, heardAt: 2 }) }, async () => {
    assert.match(await doctor(folder, noPlugin, () => plugin()), /✓ Codex: connected \(the Attentry plugin, 0\.1\.4\)\n/);
  });
});
