import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { removeHooks } from "./init.ts";
import { claude, setupFailed, type Setup } from "./mcpSetup.ts";

// The Claude Code plugin the editor extension carries: its claude/ folder is a plugin marketplace
// with the attentry plugin in it, and this Attentry built into that plugin. Installed for every
// project through Claude Code's own commands; Claude Code copies it, so an extension update needs
// the copy updated too.

const PLUGIN = "attentry@attentry";

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
  return { ok: true };
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
