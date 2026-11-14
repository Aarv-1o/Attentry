import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hooksHeard, noteInstalled, type HooksHeard } from "./heard.ts";
import { removeHooks } from "./init.ts";
import { claude, setupFailed, type Setup } from "./mcpSetup.ts";

// The Claude Code plugin the editor extension carries: its claude/ folder is a plugin marketplace
// with the attentry plugin in it, and this Attentry built into that plugin. Installed for every
// project through Claude Code's own commands; Claude Code copies it, so an extension update needs
// the copy updated too.

const PLUGIN = "attentry@attentry";
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export type PluginState = { installed: false } | { installed: true; enabled: boolean; version: string };

// The marketplace this Attentry is part of, when it runs from the extension's plugin
// (claude/attentry/dist/attentry.mjs). Undefined when it runs from anywhere else.
export function pluginHome(entry: string): string | undefined {
  const home = resolve(dirname(entry), "../..");
  return existsSync(join(home, ".claude-plugin", "marketplace.json")) ? home : undefined;
}

const versionAt = async (home: string) =>
  (JSON.parse(await readFile(join(home, "attentry", ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;

export async function pluginState(folder: string): Promise<PluginState> {
  const listed = JSON.parse((await claude(["plugin", "list", "--json"], folder)).stdout) as { id: string; enabled: boolean; version: string }[];
  const found = listed.find((p) => p.id === PLUGIN);
  return found ? { installed: true, enabled: found.enabled, version: found.version } : { installed: false };
}

// What to run by hand when `claude` can't be run from here.
const installCommands = (home: string) => `claude plugin marketplace add "${home}" && claude plugin install ${PLUGIN}`;

// Connect: installs (or repairs, or updates) the plugin, and takes out the setup it replaces in
// `folder`: hooks from `attentry init` and the MCP server added for that folder. Each would run
// beside the plugin's, checking every edit twice.
export async function installPlugin(home: string, folder: string): Promise<Setup> {
  try {
    await claude(["plugin", "marketplace", "add", home], folder); // also points it here after an update moved the extension
    await claude(["plugin", "install", PLUGIN, "--scope", "user"], folder);
    await claude(["plugin", "enable", PLUGIN], folder).catch(() => undefined); // already enabled: fine
    await claude(["plugin", "update", PLUGIN], folder);
  } catch (error) {
    return setupFailed(error, installCommands(home));
  }
  await removeHooks(folder);
  await claude(["mcp", "remove", "attentry", "--scope", "local"], folder).catch(() => undefined); // not there: fine
  await allowTools();
  await noteInstalled("claude");
  return { ok: true };
}

// Claude Code asks before an agent calls any MCP tool, and a plugin can't allow its own. Attentry's
// tools only read the repo, so Connect allows them in the person's Claude Code settings: one rule
// for the whole server. A settings file that isn't plain JSON is left alone (the tools then ask).
export const TOOLS_RULE = "mcp__plugin_attentry_attentry";
export async function allowTools(): Promise<boolean> {
  const path = join(claudeDir(), "settings.json");
  let settings: { permissions?: { allow?: string[] } & Record<string, unknown> } & Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const allow = settings.permissions?.allow ?? [];
  if (allow.includes(TOOLS_RULE)) return true;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...settings, permissions: { ...settings.permissions, allow: [...allow, TOOLS_RULE] } }, null, 2)}\n`);
  return true;
}

// When the editor starts: an installed plugin older than this extension's gets updated, so the
// agent runs the same Attentry as the editor. Returns the plugin's state.
export async function refreshPlugin(home: string, folder: string): Promise<PluginState> {
  const state = await pluginState(folder);
  if (!state.installed || state.version === (await versionAt(home))) return state;
  await claude(["plugin", "marketplace", "add", home], folder);
  await claude(["plugin", "update", PLUGIN], folder);
  return pluginState(folder);
}

// When a Claude Code session in one of `folders` was last active. Claude Code keeps each session as
// a .jsonl file under projects/, in a folder named after the session's folder: every character
// that isn't a letter or digit becomes "-" (D:\work\app is D--work-app).
async function lastSession(folders: string[]): Promise<number> {
  const times = await Promise.all(folders.map(async (folder) => {
    const dir = join(claudeDir(), "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
    const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; // no Claude Code session here yet
      throw error;
    });
    const sessions = await Promise.all(files.filter((f) => f.endsWith(".jsonl")).map(async (f) => (await stat(join(dir, f))).mtimeMs));
    return Math.max(0, ...sessions);
  }));
  return Math.max(0, ...times);
}

// What to do when it doesn't: the panel and the doctor say the same.
export const CLAUDE_UNHEARD_FIX = "Start a new Claude Code session (one open since before connecting doesn't have the hooks). If this stays, run /hooks in Claude Code to see whether Attentry's are listed, and check that `node` runs in a terminal: the hooks run with it.";

// Does Claude Code run Attentry's hooks? Judged by its sessions in these folders since connecting.
export const claudeHooks = (folders: string[]): Promise<HooksHeard> => hooksHeard("claude", () => lastSession(folders));
