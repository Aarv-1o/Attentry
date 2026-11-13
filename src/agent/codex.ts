import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { codex, setupFailed, type Setup } from "./mcpSetup.ts";

// The Codex plugins the editor extension carries: its codex/ folder, next to claude/, is a Codex
// plugin marketplace with two plugins. attentry-hooks has the hooks, and never changes: Codex asks
// the person to trust a plugin's hooks again whenever any file in it changes. attentry has the
// MCP tools and skills, and no hooks, so it can change with each release. Both run the Attentry
// in the extension, named in ~/.attentry/build.json. Installed through Codex's own commands.

const HOOKS = "attentry-hooks@attentry";
const TOOLS = "attentry@attentry";
const MARKETPLACE = "attentry";

// The Attentry that Codex's plugins run: the extension's own, beside the Claude Code plugin.
const buildOf = (home: string) => resolve(home, "..", "claude", "attentry", "dist", "attentry.mjs");
async function pointAt(home: string): Promise<void> {
  const file = join(homedir(), ".attentry", "build.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ entry: buildOf(home) })}\n`);
}

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

type Listed = { pluginId: string; enabled: boolean; version: string };
const listed = async (folder: string) => (JSON.parse((await codex(["plugin", "list", "--json"], folder)).stdout) as { installed: Listed[] }).installed;

// Connected when both plugins are in: the version is the tools plugin's, which follows releases.
export async function codexState(folder: string): Promise<CodexState> {
  const plugins = await listed(folder);
  const [hooks, tools] = [HOOKS, TOOLS].map((id) => plugins.find((p) => p.pluginId === id));
  return hooks && tools ? { installed: true, enabled: hooks.enabled && tools.enabled, version: tools.version } : { installed: false };
}

// What to run by hand when `codex` can't be run from here.
const installCommands = (home: string) => `codex plugin marketplace add "${home}" && codex plugin add ${HOOKS} && codex plugin add ${TOOLS}`;

// The marketplace points at the extension's folder, which an update moves: point it here again,
// then (re)install both plugins from it, which also brings an older tools plugin up to this
// version. The hooks plugin is the same one each time, so Codex keeps trusting it: only its
// first install is one the person has to trust.
async function addFrom(home: string, folder: string): Promise<void> {
  const hadHooks = (await listed(folder)).some((p) => p.pluginId === HOOKS);
  await codex(["plugin", "marketplace", "remove", MARKETPLACE], folder).catch(() => undefined); // not added yet: fine
  await codex(["plugin", "marketplace", "add", home], folder);
  await codex(["plugin", "add", HOOKS], folder);
  await codex(["plugin", "add", TOOLS], folder);
  await pointAt(home);
  if (!hadHooks) await note({ installedAt: Date.now() });
}

// Connect: installs, repairs or updates the plugins. Codex then asks the person to trust the
// hooks once, when it starts (or in /hooks): the panel says so.
export async function installCodex(home: string, folder: string): Promise<Setup> {
  try {
    await addFrom(home, folder);
    return { ok: true };
  } catch (error) {
    return setupFailed(error, installCommands(home), "Codex's `codex`");
  }
}

// When the editor starts: Codex's plugins run this extension's Attentry (an update moves it), and
// a tools plugin older than this extension's is updated. Returns the plugins' state.
export async function refreshCodex(home: string, folder: string): Promise<CodexState> {
  const state = await codexState(folder);
  if (!state.installed) return state;
  if (state.version === (await versionAt(home))) {
    await pointAt(home);
    return state;
  }
  await addFrom(home, folder);
  return codexState(folder);
}
