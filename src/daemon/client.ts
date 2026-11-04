import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import type { HookInput, HookReply } from "../agent/hooks.ts";
import { Sessions, type AgentStatus } from "../agent/session.ts";
import type { ToolResult } from "../agent/tools.ts";
import { addressFor, buildId } from "./address.ts";
import type { Request, Response } from "./server.ts";

// Asks the repo's background Detron, starting it if it isn't running. If it can't start, the
// question is answered right here, slower and without memory of the task.

const START_WAIT_MS = 20_000; // its first scan reads the whole repo
const POLL_MS = 150;

function ask(address: string, request: Request): Promise<Response> {
  return new Promise((done, fail) => {
    const socket = createConnection(address, () => socket.write(`${JSON.stringify(request)}\n`));
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => (text ? done(JSON.parse(text) as Response) : fail(new Error("the background Detron closed without answering"))));
    socket.on("error", fail);
  });
}

// The same Detron that's running now (same Node flags and entry file), in the background.
function startBackground(root: string): void {
  // From Detron's own folder: Node flags like `--import tsx` resolve there, not in the repo.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "serve", root], { cwd: dirname(process.argv[1]!), detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

const notRunning = (error: unknown) => ["ENOENT", "ECONNREFUSED", "EPIPE", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "");

// Is a background Detron answering for this repo? Asks without starting one.
export async function backgroundRunning(root: string): Promise<boolean> {
  try {
    await ask(addressFor(root), { kind: "status" });
    return true;
  } catch (error) {
    if (notRunning(error)) return false;
    throw error;
  }
}

// The agent's task as the background Detron sees it, without starting one: undefined when no
// agent is working in this repo.
export async function agentStatus(root: string): Promise<AgentStatus | undefined> {
  try {
    const response = await ask(addressFor(root), { kind: "status" });
    return "status" in response ? (response.status ?? undefined) : undefined;
  } catch (error) {
    if (notRunning(error)) return undefined;
    throw error;
  }
}

// Asks the background Detron, starting it if needed. `here` answers in this process when it
// can't start: slower, and without the task's history.
async function viaBackground<T>(root: string, request: Request, pick: (r: Response) => T | undefined, here: () => Promise<T>): Promise<T> {
  const address = addressFor(root);
  let started = false;
  const deadline = Date.now() + START_WAIT_MS;
  for (;;) {
    let response: Response | undefined;
    try {
      response = await ask(address, request);
    } catch (error) {
      if (!notRunning(error)) throw error;
    }
    const answer = response && pick(response);
    if (answer !== undefined) return answer;
    if (response && "error" in response) throw new Error(`the background Detron failed: ${response.error}`);
    // Not running, or an older Detron that just stopped: start this one and try again.
    if (!started || (response && "restart" in response)) {
      startBackground(root);
      started = true;
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return here();
}

export const hookReply = (root: string, input: HookInput): Promise<HookReply> =>
  viaBackground(root, { kind: "hook", build: buildId(), input }, (r) => ("reply" in r ? r.reply : undefined), () => new Sessions(root).handle(input));

export const toolReply = (root: string, name: string, args: Record<string, unknown>, session?: string): Promise<ToolResult> =>
  viaBackground(root, { kind: "tool", build: buildId(), name, args, session }, (r) => ("result" in r ? r.result : undefined), () => new Sessions(root).tool(name, args));

// An MCP server's task starts now. Without a background Detron there's no task to remember: nothing to do.
export const beginTask = async (root: string, session: string): Promise<void> => {
  await viaBackground(root, { kind: "begin", build: buildId(), session }, (r) => ("ok" in r ? true : undefined), async () => false);
};
