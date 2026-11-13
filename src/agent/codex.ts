import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { codex, setupFailed, type Setup } from "./mcpSetup.ts";

// The Codex plugin the editor extension carries: its codex/ folder, next to claude/, is a Codex
// plugin marketplace with the attentry plugin in it. Installed through Codex's own commands; Codex
// copies it into its cache, so an extension update needs the copy updated too.

const PLUGIN = "attentry@attentry";
const MARKETPLACE = "attentry";

export type CodexState = { installed: false } | { installed: true; enabled: boolean; version: string };

const codexDir = () => process.env.CODEX_HOME || join(homedir(), ".codex");

// Has this person used Codex here? Its folder appears on first run. Without it the panel leaves
// Codex out, and nothing runs `codex`.
export const codexUsed = () => existsSync(codexDir());

// Codex runs a plugin's hooks only once the person trusts them, and asks again when they change.
// So Attentry notes when it installed the plugin and when Codex last ran its SessionStart hook
// (~/.attentry/codex.json): heard from since the install means trusted. A Codex session since the
// install without a word from the hooks means they're waiting for the person.
const heardFile = () => join(homedir(), ".attentry", "codex.json");
type Heard = { installedAt?: number; heardAt?: number };

async function readHeard(): Promise<Heard> {
  try {
    return JSON.parse(await readFile(heardFile(), "utf8")) as Heard;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; // never installed or heard from
    throw error;
  }
}

async function note(change: Heard): Promise<void> {
  const now = await readHeard();
  await mkdir(dirname(heardFile()), { recursive: true });
  await writeFile(heardFile(), `${JSON.stringify({ ...now, ...change })}\n`);
}

export const noteHeard = () => note({ heardAt: Date.now() });

// The newest Codex session's last activity, from Codex's own list of sessions.
async function lastSession(): Promise<number> {
  const index = await readFile(join(codexDir(), "session_index.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""; // no sessions yet
    throw error;
  });
  return Math.max(0, ...index.split("\n").filter(Boolean).map((line) => Date.parse((JSON.parse(line) as { updated_at?: string }).updated_at ?? "") || 0));
}

// "running": Codex runs the hooks. "waiting": no Codex session since the install yet. "approve":
// sessions ran without them, so the person hasn't trusted them (or Codex was open since before).
export type CodexHooks = "running" | "waiting" | "approve";
export async function codexHooks(): Promise<CodexHooks> {
  const { installedAt = 0, heardAt = 0 } = await readHeard();
  if (heardAt && heardAt >= installedAt) return "running";
  return (await lastSession()) > installedAt ? "approve" : "waiting";
}

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
  await note({ installedAt: Date.now() });
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
