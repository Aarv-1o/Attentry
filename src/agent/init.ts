import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { projectRoot } from "../index/project.ts";
import { loadConfig, writeMode } from "./config.ts";
import { findTests, type TestCommand } from "./tests.ts";
import { allowTests } from "./trust.ts";

// `attentry init`: sets up Attentry's hooks for Claude Code in a repo, for running Attentry from its
// source (the editor extension installs a plugin instead). In .claude/settings.local.json: it names
// where Attentry is on this machine, so it isn't one to commit.

const EDITS = "Write|Edit|MultiEdit|NotebookEdit";
const TIMEOUT_S = 60; // the first hook of a session scans the whole repo

interface Handler { type: string; command: string; timeout?: number }
interface Group { matcher?: string; hooks: Handler[] }
type Settings = { hooks?: Record<string, Group[]> } & Record<string, unknown>;

// The command hookCommand writes: the built Attentry (attentry.mjs) or the editor extension's copy
// of it (server.mjs), wherever either is installed.
const isAttentry = (h: Handler) => /[\\/](attentry|server)\.mjs" hook claude$/.test(h.command);

// The settings without Attentry's hooks, keeping the rest.
function withoutAttentryHooks(settings: Settings): Settings {
  const hooks: Record<string, Group[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isAttentry(h)) })).filter((g) => g.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  return { ...settings, hooks };
}

// The settings with Attentry's hooks added, replacing any it added before and keeping the rest.
export function withAttentryHooks(settings: Settings, command: string): Settings {
  const hooks = withoutAttentryHooks(settings).hooks!;
  const handler = { type: "command", command, timeout: TIMEOUT_S };
  const add = (event: string, group: Group) => (hooks[event] = [...(hooks[event] ?? []), group]);
  add("SessionStart", { hooks: [handler] });
  add("UserPromptSubmit", { hooks: [handler] }); // the related code the repo has, with each request
  add("PreToolUse", { matcher: EDITS, hooks: [handler] });
  add("PreToolUse", { matcher: "ExitPlanMode", hooks: [handler] }); // notes on a plan before Claude starts it
  add("PostToolUse", { matcher: EDITS, hooks: [handler] });
  add("Stop", { hooks: [handler] });
  return { ...settings, hooks };
}

// The built Attentry: hooks run it with plain node, from the repo's folder.
export function hookCommand(entry: string): string {
  const built = entry.endsWith(".mjs") ? entry : resolve(dirname(entry), "../../dist/attentry.mjs");
  if (!existsSync(built)) throw new Error(`Attentry isn't built yet: run \`npm run build\` in Attentry's folder first (looked for ${built}).`);
  return `node "${built.replace(/\\/g, "/")}" hook claude`;
}

// The MCP server, for agents to call Attentry themselves (see mcpSetup.ts). Added per person, not
// to the repo's .mcp.json: the path is this machine's.
export const mcpSetup = (command: string) =>
  `For tools the agent can call (find_existing, check, explain), add Attentry's MCP server (run this in the repo's folder):\n  ${command}`;

export async function init(root: string, entry: string, mode: "suggest" | "block" | undefined): Promise<string[]> {
  const command = hookCommand(entry);
  const path = join(root, ".claude/settings.local.json");
  let settings: Settings = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(await readFile(path, "utf8")) as Settings;
    } catch (error) {
      throw new Error(`Can't read ${path} (${(error as Error).message}). Fix it or move it away, then run init again: Attentry won't overwrite it.`);
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(withAttentryHooks(settings, command), null, 2)}\n`);
  const done = [`Claude Code hooks: ${path} (session start, before and after each edit, at the end)`];
  // Hooks go where Claude Code starts; the mode and the tests go with the project Attentry checks.
  const project = await projectRoot(root);
  if (mode) done.push(`Mode: ${mode} (${await writeMode(project, mode)})`);
  const tests = await allowCurrentTests(project);
  if (tests.length) done.push(`Tests Attentry may run at check-ins: ${tests.map((t) => (t.runs === t.command ? t.command : `${t.label} (${t.runs})`)).join(", ")}. If they change, run init again to allow the new ones`);
  return done;
}

// Connecting Attentry (init, or Connect in the editor) is the person saying yes to its test runs:
// only the project's commands as they are now. Returns them.
export async function allowCurrentTests(project: string): Promise<TestCommand[]> {
  const tests = await findTests(project, (await loadConfig(project)).tests);
  if (tests.length) await allowTests(project, tests);
  return tests;
}

// Takes out hooks `init` added: the plugin runs the same ones, and both would check every edit twice.
export async function removeHooks(root: string): Promise<void> {
  const path = join(root, ".claude/settings.local.json");
  let settings: Settings;
  try {
    settings = JSON.parse(await readFile(path, "utf8")) as Settings;
  } catch {
    return; // no settings, or unreadable: no hooks of Attentry's to take out
  }
  const without = withoutAttentryHooks(settings);
  if (JSON.stringify(without.hooks) !== JSON.stringify(settings.hooks ?? {})) await writeFile(path, `${JSON.stringify(without, null, 2)}\n`);
}

// Are Attentry's hooks set up here, and does the Attentry they run still exist (an extension
// update moves it)?
export async function hookState(root: string): Promise<"connected" | "missing" | "stale"> {
  let settings: Settings;
  try {
    settings = JSON.parse(await readFile(join(root, ".claude/settings.local.json"), "utf8")) as Settings;
  } catch {
    return "missing"; // no settings, or unreadable: either way Attentry's hooks aren't running
  }
  const command = Object.values(settings.hooks ?? {}).flat().flatMap((g) => g.hooks).find(isAttentry)?.command;
  if (!command) return "missing";
  const path = /"([^"]+)"/.exec(command)?.[1];
  return path && existsSync(path) ? "connected" : "stale";
}
