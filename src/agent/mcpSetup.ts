import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hookCommand } from "./init.ts";

// Attentry's MCP server in Claude Code: is it added for a folder, and adding it. Claude Code keeps
// it in ~/.claude.json, so it's added through Claude Code's own command, never by editing that
// file; reading it, only the attentry entries are looked at.

const run = promisify(execFile);

export interface McpServer { command?: string; args?: string[] }

const same = (a: string, b: string) => resolve(a).replace(/\\/g, "/").toLowerCase() === resolve(b).replace(/\\/g, "/").toLowerCase();
const readJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined; // missing or unreadable: nothing set up there
  }
};

// This folder's (`--scope local`), the repo's .mcp.json, then every folder's (user scope).
export async function attentryMcp(folders: string[]): Promise<{ where: string; server: McpServer } | undefined> {
  const user = await readJson(join(homedir(), ".claude.json"));
  const projects = (user?.projects ?? {}) as Record<string, { mcpServers?: Record<string, McpServer> }>;
  for (const folder of folders) {
    // Claude Code keeps d:/repo and D:/repo apart (VS Code says d:, a terminal D:): any of them counts.
    const local = Object.keys(projects).filter((k) => same(k, folder)).map((k) => projects[k]?.mcpServers?.attentry).find(Boolean);
    if (local) return { where: `Claude Code, for ${folder}`, server: local };
    const shared = ((await readJson(join(folder, ".mcp.json")))?.mcpServers as Record<string, McpServer> | undefined)?.attentry;
    if (shared) return { where: join(folder, ".mcp.json"), server: shared };
  }
  const everywhere = (user?.mcpServers as Record<string, McpServer> | undefined)?.attentry;
  return everywhere ? { where: "Claude Code, for every folder", server: everywhere } : undefined;
}

// The Attentry file an MCP entry runs, if it names one.
export const attentryPath = (server: McpServer) => server.args?.find((a) => /attentry[\w.-]*\.mjs$|server\.mjs$/.test(a));

// "added", "missing", or "stale" (it runs an Attentry that has moved, like hooks after an update).
export async function mcpState(folder: string): Promise<"added" | "missing" | "stale"> {
  const found = await attentryMcp([folder]);
  if (!found) return "missing";
  const path = attentryPath(found.server);
  return path && !existsSync(path) ? "stale" : "added";
}

export const mcpAddCommand = (entry: string) => `claude mcp add attentry --scope local -- ${hookCommand(entry).replace(/ hook claude$/, " mcp")}`;

// An agent's own command, run in `folder`: its name, or `env` when it's somewhere else. Usually an
// .exe, started directly. An npm install on Windows gives a .cmd (Codex's always is), which only a
// shell can start (Node refuses it without one: ENOENT by name, EINVAL by path): then one command
// line, with what has spaces or shell characters quoted.
const agentCommand = (name: string, env: string) => async (args: string[], folder: string) => {
  const command = process.env[env] || name;
  const options = { cwd: folder, timeout: 60_000, windowsHide: true };
  try {
    return await run(command, args, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "ENOENT" && code !== "EINVAL")) throw error;
    const line = [command, ...args].map((a) => (/[\s&()^|<>"]/.test(a) ? `"${a}"` : a)).join(" ");
    return run(line, [], { ...options, shell: true });
  }
};
export const claude = agentCommand("claude", "ATTENTRY_CLAUDE");
export const codex = agentCommand("codex", "ATTENTRY_CODEX");

export type Setup = { ok: true } | { ok: false; reason: string; command: string };

// Why running the agent's command failed, for the person, with the command they can run themselves.
export function setupFailed(error: unknown, command: string, agent = "Claude Code's `claude`"): Setup {
  const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || /not recognized|not found/i.test(String((error as { stderr?: string }).stderr ?? ""));
  return { ok: false, reason: missing ? `${agent} command isn't installed` : (error as Error).message.split("\n")[0]!, command };
}

// Adds (or re-adds, after an update moved Attentry) the server for `folder`, with Claude Code's own
// command. When Claude Code's command isn't installed, says so with the line to run.
export async function addMcp(folder: string, entry: string): Promise<Setup> {
  const built = hookCommand(entry).match(/^node "(.+)" hook claude$/)![1]!;
  try {
    await claude(["mcp", "remove", "attentry", "--scope", "local"], folder).catch(() => undefined); // not there yet: fine
    await claude(["mcp", "add", "attentry", "--scope", "local", "--", "node", built, "mcp"], folder);
    return { ok: true };
  } catch (error) {
    return setupFailed(error, mcpAddCommand(entry));
  }
}
