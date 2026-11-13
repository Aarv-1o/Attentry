import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codex, setupFailed, type Setup } from "./mcpSetup.ts";

// The Codex plugin the editor extension carries: its codex/ folder, next to claude/, is a Codex
// plugin marketplace with the attentry plugin in it. Installed through Codex's own commands; Codex
// copies it into its cache, so an extension update needs the copy updated too.

const PLUGIN = "attentry@attentry";
const MARKETPLACE = "attentry";

export type CodexState = { installed: false } | { installed: true; enabled: boolean; version: string };

// Has this person used Codex here? Its folder appears on first run. Without it the panel leaves
// Codex out, and nothing runs `codex`.
export const codexUsed = () => existsSync(process.env.CODEX_HOME || join(homedir(), ".codex"));

// The Codex marketplace beside the Claude Code one (pluginHome), if the extension carries it.
export function codexHome(claudeHome: string): string | undefined {
  const home = resolve(claudeHome, "..", "codex");
  return existsSync(join(home, ".agents", "plugins", "marketplace.json")) ? home : undefined;
}

const versionAt = async (home: string) =>
  (JSON.parse(await readFile(join(home, "attentry", ".codex-plugin", "plugin.json"), "utf8")) as { version: string }).version;

export async function codexState(folder: string): Promise<CodexState> {
  const { installed } = JSON.parse((await codex(["plugin", "list", "--json"], folder)).stdout) as { installed: { pluginId: string; enabled: boolean; version: string }[] };
  const found = installed.find((p) => p.pluginId === PLUGIN);
  return found ? { installed: true, enabled: found.enabled, version: found.version } : { installed: false };
}

// What to run by hand when `codex` can't be run from here.
const installCommands = (home: string) => `codex plugin marketplace add "${home}" && codex plugin add ${PLUGIN}`;

// The marketplace points at the extension's folder, which an update moves: point it here again,
// then (re)install the plugin from it, which also brings an older copy up to this version.
async function addFrom(home: string, folder: string): Promise<void> {
  await codex(["plugin", "marketplace", "remove", MARKETPLACE], folder).catch(() => undefined); // not added yet: fine
  await codex(["plugin", "marketplace", "add", home], folder);
  await codex(["plugin", "add", PLUGIN], folder);
}

// Connect: installs, repairs or updates the plugin. Codex then asks the person to trust its hooks
// once, when it starts (or in /hooks): the panel says so.
export async function installCodex(home: string, folder: string): Promise<Setup> {
  try {
    await addFrom(home, folder);
    return { ok: true };
  } catch (error) {
    return setupFailed(error, installCommands(home), "Codex's `codex`");
  }
}

// When the editor starts: an installed plugin older than this extension's gets updated, so Codex
// runs the same Attentry as the editor. Returns the plugin's state.
export async function refreshCodex(home: string, folder: string): Promise<CodexState> {
  const state = await codexState(folder);
  if (!state.installed || state.version === (await versionAt(home))) return state;
  await addFrom(home, folder);
  return codexState(folder);
}
