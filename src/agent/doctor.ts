import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { backgroundRunning } from "../daemon/client.ts";
import { codexHooks, codexState, codexUsed, type CodexState } from "./codex.ts";
import { isSource, listRepoFiles, unsupportedCode } from "../index/files.ts";
import { projectRoot } from "../index/project.ts";
import { loadConfig } from "./config.ts";
import { hookState } from "./init.ts";
import { findTests } from "./tests.ts";
import { testsAllowed } from "./trust.ts";
import { attentryMcp, attentryPath } from "./mcpSetup.ts";
import { CLAUDE_UNHEARD_FIX, claudeHooks, pluginState, type PluginState } from "./plugin.ts";
import { plural } from "../report/common.ts";

// Is Attentry set up here, and working? One check per line, with what to do when it isn't: the
// panel's Check setup, and `attentry doctor` (agents can run it too, when asked "is Attentry
// connected?").

// A fix the panel does with a click: its button, in place of the words.
export type SetupAction = "connectAgent" | "connectCodex" | "allowTests";
export type Check = { ok: boolean | "warn"; text: string; fix?: string; action?: SetupAction };

export interface SetupOptions {
  // Ask Claude Code and Codex which plugins they have (tests answer for them).
  plugin?: (folder: string) => Promise<PluginState>;
  codex?: (folder: string) => Promise<CodexState>;
  // Run from the editor extension, which carries the plugins: Connect is how Claude Code is set up,
  // never the folder hooks and MCP server of running Attentry from its source.
  extension?: boolean;
}

export async function doctor(folder: string, options: SetupOptions = {}): Promise<string> {
  const mark = (c: Check) => (c.ok === true ? "✓" : c.ok === "warn" ? "!" : "✗");
  return `${(await checkSetup(folder, options)).map((c) => `${mark(c)} ${c.text}${c.fix ? `\n  → ${c.fix}` : ""}`).join("\n")}\n`;
}

export async function checkSetup(folder: string, { plugin = pluginState, codex = codexState, extension = false }: SetupOptions = {}): Promise<Check[]> {
  const root = await projectRoot(folder);
  const checks: Check[] = [];
  const files = await listRepoFiles(root);
  const code = files.filter(isSource).length;
  const skipped = [...unsupportedCode(files)].map(([ext, n]) => `${n} .${ext}`).join(", ");
  checks.push(root === folder
    ? { ok: code > 0, text: `Project: ${root} (${plural(code, "file")} Attentry reads${skipped ? `; not read: ${skipped}` : ""})`, ...(code ? {} : { fix: "No JavaScript, TypeScript or Python here: open the project's own folder." }) }
    : { ok: true, text: `Project: ${relative(folder, root)}, inside the folder you're in (${plural(code, "file")} Attentry reads)` });
  const git = existsSync(join(root, ".git"));
  checks.push(git
    ? { ok: true, text: "Git: yes, so \"your changes\" means what this branch or your uncommitted work changed" }
    : { ok: "warn", text: "Git: no, so Attentry can't tell what changed, and \"your changes\" is everything", fix: "Run `git init` and commit once: then only new problems are reported." });

  const config = await loadConfig(root);
  checks.push({ ok: true, text: `Mode: ${config.mode}` });
  const tests = config.tests === "off" ? [] : await findTests(root, config.tests);
  checks.push(config.tests === "off"
    ? { ok: true, text: "Tests: off (\"tests\": \"off\" in .attentry/config.json)" }
    : !tests.length
      ? { ok: "warn", text: "Tests: none found, so the change card can't say whether they pass", fix: "Set \"tests\": \"<command>\" in .attentry/config.json, then allow it." }
      : (await testsAllowed(root, tests))
        ? { ok: true, text: `Tests: ${tests.map((t) => t.label).join(", ")}, run at check-ins` }
        : { ok: "warn", text: `Tests: ${tests.map((t) => t.label).join(", ")} found, but not allowed yet (or changed since)`, fix: "Click Allow tests in the Attentry sidebar (or run `attentry init` here): it runs only what you allowed.", action: "allowTests" });

  // Claude Code: the plugin (from the editor extension) brings the hooks and MCP tools together.
  // Without it, the hooks `attentry init` sets up in the folder, and MCP tools added by hand.
  const installed = await plugin(folder).catch(() => undefined); // no `claude` command: as if not installed
  if (installed?.installed && installed.enabled) checks.push(await heardCheck(`Claude Code: connected (the Attentry plugin, ${installed.version})`, folder, root));
  else if (installed?.installed) checks.push({ ok: false, text: "Claude Code: the Attentry plugin is installed but turned off", fix: "Click Connect Claude Code in the Attentry sidebar, or run `claude plugin enable attentry@attentry`.", action: "connectAgent" });
  else if (extension) checks.push({ ok: false, text: "Claude Code: not connected", fix: "Click Connect Claude Code in the Attentry sidebar.", action: "connectAgent" });
  else await withoutPlugin(folder, root, checks);
  if (codexUsed()) checks.push(await codexCheck(folder, codex));

  checks.push((await backgroundRunning(root))
    ? { ok: true, text: "Background Attentry: running" }
    : { ok: true, text: "Background Attentry: not running (it starts on the agent's first edit or tool call)" });
  return checks;
}

// Codex, for someone who uses it: only the plugin connects it. Not connected is a note, not a
// failure: Codex is optional.
async function codexCheck(folder: string, codex: (folder: string) => Promise<CodexState>): Promise<Check> {
  const state = await codex(folder).catch(() => undefined); // no `codex` command: as if not installed
  if (!state?.installed) return { ok: "warn", text: "Codex: not connected", fix: "Click Connect Codex in the Attentry sidebar.", action: "connectCodex" };
  if (!state.enabled) return { ok: false, text: "Codex: the Attentry plugin is installed but turned off", fix: "Click Connect Codex in the Attentry sidebar to turn it back on.", action: "connectCodex" };
  const hooks = await codexHooks();
  if (hooks === "approve") return { ok: false, text: `Codex: the Attentry plugin is installed (${state.version}), but Codex hasn't run its hooks`, fix: "In Codex, run /hooks and trust Attentry's hooks, then start a new session." };
  return { ok: true, text: `Codex: connected (the Attentry plugin, ${state.version})${hooks === "waiting" ? ". Codex asks you to trust its hooks when it next starts" : ""}` };
}

// Connected isn't running: has Claude Code run Attentry's hooks since?
async function heardCheck(connected: string, folder: string, root: string): Promise<Check> {
  const heard = await claudeHooks([folder, root]);
  if (heard === "unheard") return { ok: false, text: `${connected}, but Claude Code ran here since without running Attentry's hooks`, fix: CLAUDE_UNHEARD_FIX };
  return { ok: true, text: heard === "running" ? `${connected}, and Claude Code runs its hooks` : `${connected}. A session started before that needs a restart` };
}

// Set up by hand, without the plugin: hooks in the folder, and the MCP server.
async function withoutPlugin(folder: string, root: string, checks: Check[]): Promise<void> {
  const hooks = await hookState(folder);
  checks.push(hooks === "connected"
    ? await heardCheck("Claude Code hooks: set up, and the Attentry they run is there", folder, root)
    : hooks === "stale"
      ? { ok: false, text: "Claude Code hooks: set up, but the Attentry they run has moved", fix: "Click Reconnect Claude Code in the Attentry sidebar, or run `attentry init` again.", action: "connectAgent" }
      : { ok: false, text: "Claude Code: not connected", fix: "Click Connect Claude Code in the Attentry sidebar, or run `attentry init` here.", action: "connectAgent" });
  const mcp = await attentryMcp(root === folder ? [folder] : [folder, root]);
  const mcpPath = mcp && attentryPath(mcp.server);
  checks.push(!mcp
    ? { ok: "warn", text: "MCP tools (find_existing, check, explain, check_plan): not added for Claude Code here", fix: "Run the `claude mcp add` line that `attentry init` prints." }
    : mcpPath && !existsSync(mcpPath)
      ? { ok: false, text: `MCP tools: added (${mcp.where}), but ${mcpPath} isn't there`, fix: "Add it again with the path to your Attentry." }
      : { ok: true, text: `MCP tools: added (${mcp.where}). A Claude Code session started before that needs a restart to see them` });
}
