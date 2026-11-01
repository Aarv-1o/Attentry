import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hookCommand } from "./init.ts";

// Detron's MCP server in Claude Code: is it added for a folder, and adding it. Claude Code keeps
// it in ~/.claude.json, so it's added through Claude Code's own command, never by editing that
// file; reading it, only the detron entries are looked at.

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
export async function detronMcp(folders: string[]): Promise<{ where: string; server: McpServer } | undefined> {
  const user = await readJson(join(homedir(), ".claude.json"));
  const projects = (user?.projects ?? {}) as Record<string, { mcpServers?: Record<string, McpServer> }>;
  for (const folder of folders) {
    const key = Object.keys(projects).find((k) => same(k, folder));
    const local = key ? projects[key]?.mcpServers?.detron : undefined;
    if (local) return { where: `Claude Code, for ${folder}`, server: local };
    const shared = ((await readJson(join(folder, ".mcp.json")))?.mcpServers as Record<string, McpServer> | undefined)?.detron;
    if (shared) return { where: join(folder, ".mcp.json"), server: shared };
  }
  const everywhere = (user?.mcpServers as Record<string, McpServer> | undefined)?.detron;
  return everywhere ? { where: "Claude Code, for every folder", server: everywhere } : undefined;
}

// The Detron file an MCP entry runs, if it names one.
export const detronPath = (server: McpServer) => server.args?.find((a) => /detron[\w.-]*\.mjs$|server\.mjs$/.test(a));

// "added", "missing", or "stale" (it runs a Detron that has moved, like hooks after an update).
export async function mcpState(folder: string): Promise<"added" | "missing" | "stale"> {
  const found = await detronMcp([folder]);
  if (!found) return "missing";
  const path = detronPath(found.server);
  return path && !existsSync(path) ? "stale" : "added";
}

export const mcpAddCommand = (entry: string) => `claude mcp add detron --scope local -- ${hookCommand(entry).replace(/ hook claude$/, " mcp")}`;

// Adds (or re-adds, after an update moved Detron) the server for `folder`, with Claude Code's own
// command. When Claude Code's command isn't installed, says so with the line to run.
export async function addMcp(folder: string, entry: string): Promise<{ ok: true } | { ok: false; reason: string; command: string }> {
  const command = mcpAddCommand(entry);
  const built = hookCommand(entry).match(/^node "(.+)" hook claude$/)![1]!;
  // claude is a .cmd on Windows, which only a shell can start.
  const claude = (args: string[]) => run("claude", args, { cwd: folder, timeout: 30_000, shell: process.platform === "win32", windowsHide: true });
  try {
    await claude(["mcp", "remove", "detron", "--scope", "local"]).catch(() => undefined); // not there yet: fine
    await claude(["mcp", "add", "detron", "--scope", "local", "--", "node", process.platform === "win32" ? `"${built}"` : built, "mcp"]);
    return { ok: true };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || /not recognized|not found/i.test(String((error as { stderr?: string }).stderr ?? ""));
    return { ok: false, reason: missing ? "Claude Code's `claude` command isn't installed" : (error as Error).message.split("\n")[0]!, command };
  }
}
