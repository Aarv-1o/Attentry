import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFile } from "atomically";
import { hooksHeard, noteInstalled } from "./heard.ts";
import { byVersion, codex, setupFailed, type Setup } from "./mcpSetup.ts";

// The Codex plugins the editor extension carries: its codex/ folder, next to claude/, is a Codex
// plugin marketplace with two plugins. attentry-hooks has the hooks, and never changes: Codex asks
// the person to trust a plugin's hooks again whenever any file in it changes. attentry has the
// MCP tools and skills, and no hooks, so it can change with each release. Both run the Attentry
// in the extension, named in ~/.attentry/build.json. Installed through Codex's own commands.

const HOOKS = "attentry-hooks@attentry";
const TOOLS = "attentry@attentry";
const MARKETPLACE = "attentry";

// The Attentry that Codex's plugins run: the extension's own, beside the Claude Code plugin. Each
// editor with the extension (VS Code, Cursor) points it at its own when it starts: a newer one
// another editor has stays, while it's still installed, so Codex runs the newest Attentry there is.
const buildOf = (home: string) => resolve(home, "..", "claude", "attentry", "dist", "attentry.mjs");
type Build = { entry: string; version?: string };

async function pointAt(home: string): Promise<void> {
  const file = join(homedir(), ".attentry", "build.json");
  const mine: Build = { entry: buildOf(home), version: await versionAt(home) };
  const now = await readFile(file, "utf8").then((text) => JSON.parse(text) as Build, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined; // Codex isn't pointed anywhere yet
    throw error;
  });
  const newer = now && now.entry !== mine.entry && now.version && byVersion(now.version, mine.version!) > 0 && existsSync(now.entry);
  if (newer) return;
  await writeFile(file, `${JSON.stringify(mine)}\n`);
}

// `lost`: the plugins were there, from an extension folder that's gone (see `listed`).
export type CodexState = { installed: false; lost?: boolean } | { installed: true; enabled: boolean; version: string };

const codexDir = () => process.env.CODEX_HOME || join(homedir(), ".codex");

// Has this person used Codex here? Its folder appears on first run. Without it the panel leaves
// Codex out, and nothing runs `codex`.
export const codexUsed = () => existsSync(codexDir());

// The newest Codex session's last activity, from Codex's own list of sessions.
async function lastSession(): Promise<number> {
  const index = await readFile(join(codexDir(), "session_index.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""; // no sessions yet
    throw error;
  });
  return Math.max(0, ...index.split("\n").filter(Boolean).map((line) => Date.parse((JSON.parse(line) as { updated_at?: string }).updated_at ?? "") || 0));
}

// Codex runs a plugin's hooks only once the person trusts them, and asks again when they change:
// a Codex session without a word from them means they're waiting for the person's OK.
export type CodexHooks = "running" | "waiting" | "approve";
export async function codexHooks(): Promise<CodexHooks> {
  const heard = await hooksHeard("codex", lastSession);
  return heard === "unheard" ? "approve" : heard;
}

// The Codex marketplace beside the Claude Code one (pluginHome), if the extension carries it.
export function codexHome(claudeHome: string): string | undefined {
  const home = resolve(claudeHome, "..", "codex");
  return existsSync(join(home, ".agents", "plugins", "marketplace.json")) ? home : undefined;
}

const versionAt = async (home: string) =>
  (JSON.parse(await readFile(join(home, "attentry", ".codex-plugin", "plugin.json"), "utf8")) as { version: string }).version;

type Listed = { pluginId: string; enabled: boolean; version: string };

// Codex fails every plugin command while Attentry's marketplace is a folder that's gone: the
// extension uninstalled, or updated from the command line, which deletes the old folder at once.
const LOST = new RegExp(`\`${MARKETPLACE}\` at [^\\n]*: marketplace root does not contain a supported manifest`);

// The plugins Codex has. Attentry's marketplace lost that way is forgotten, which takes its plugins
// with it: `lost` says they were there, so they're added again from this extension.
async function listed(folder: string): Promise<{ plugins: Listed[]; lost: boolean }> {
  const list = async () => (JSON.parse((await codex(["plugin", "list", "--json"], folder)).stdout) as { installed: Listed[] }).installed;
  try {
    return { plugins: await list(), lost: false };
  } catch (error) {
    if (!LOST.test(`${(error as Error).message}\n${(error as { stderr?: string }).stderr ?? ""}`)) throw error;
    await codex(["plugin", "marketplace", "remove", MARKETPLACE], folder);
    return { plugins: await list(), lost: true };
  }
}

// Connected when both plugins are in: the version is the tools plugin's, which follows releases.
export async function codexState(folder: string): Promise<CodexState> {
  const { plugins, lost } = await listed(folder);
  const [hooks, tools] = [HOOKS, TOOLS].map((id) => plugins.find((p) => p.pluginId === id));
  return hooks && tools ? { installed: true, enabled: hooks.enabled && tools.enabled, version: tools.version } : { installed: false, ...(lost ? { lost } : {}) };
}

// What to run by hand when `codex` can't be run from here.
const installCommands = (home: string) => `codex plugin marketplace add "${home}" && codex plugin add ${HOOKS} && codex plugin add ${TOOLS}`;

// The marketplace points at the extension's folder, which an update moves: point it here again,
// then (re)install both plugins from it, which also brings an older tools plugin up to this
// version. The hooks plugin is the same one each time, so Codex keeps trusting it: only its
// first install is one the person has to trust.
async function addFrom(home: string, folder: string): Promise<void> {
  const hadHooks = (await listed(folder)).plugins.some((p) => p.pluginId === HOOKS);
  await codex(["plugin", "marketplace", "remove", MARKETPLACE], folder).catch(() => undefined); // not added yet: fine
  await codex(["plugin", "marketplace", "add", home], folder);
  await codex(["plugin", "add", HOOKS], folder);
  await codex(["plugin", "add", TOOLS], folder);
  await pointAt(home);
  if (!hadHooks) await noteInstalled("codex");
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
  // Connected before, from a folder that's gone: connected again, from this one.
  if (!state.installed && state.lost) {
    await addFrom(home, folder);
    return codexState(folder);
  }
  if (!state.installed) return state;
  // Up to date, or newer from the other editor: only an older tools plugin is replaced.
  if (byVersion(state.version, await versionAt(home)) >= 0) {
    await pointAt(home);
    return state;
  }
  await addFrom(home, folder);
  return codexState(folder);
}
