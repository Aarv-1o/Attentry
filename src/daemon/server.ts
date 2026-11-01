import { rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import type { HookInput, HookReply } from "../agent/hooks.ts";
import { Sessions, type AgentStatus } from "../agent/session.ts";
import type { ToolResult } from "../agent/tools.ts";
import { addressFor, buildId } from "./address.ts";

// `detron serve`: the background Detron for one repo. Hooks and MCP tools ask it instead of
// scanning from scratch: it keeps what each file taught us in memory, and each agent session's
// task. Nothing is written to disk. It stops after a quiet half hour.

export type Request =
  | { kind: "hook"; build: string; input: HookInput }
  | { kind: "tool"; build: string; name: string; args: Record<string, unknown> }
  | { kind: "ping"; build: string }
  | { kind: "status" };
export type Response =
  | { reply: HookReply } | { result: ToolResult } | { ok: true } | { restart: true } | { error: string } | { status: AgentStatus | null };

const IDLE_MS = 30 * 60 * 1000;

// Is something already answering there? A socket file left by a crash is not.
const answering = (address: string) => new Promise<boolean>((done) => {
  const probe = createConnection(address, () => (probe.end(), done(true)));
  probe.on("error", () => done(false));
});

export async function serve(root: string): Promise<void> {
  const address = addressFor(root);
  if (await answering(address)) return; // another one got there first: it serves this repo
  if (process.platform !== "win32") rmSync(address, { force: true }); // left by a crash
  const sessions = new Sessions(root);
  const build = buildId();
  let queue = Promise.resolve();
  let idle: NodeJS.Timeout;
  const server = createServer((socket: Socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(text.slice(0, end)) as Request;
      // One at a time: requests share the cache and the tasks.
      queue = queue.then(() => answer(request)).catch((error: Error) => ({ error: error.stack ?? String(error) })).then((response: Response) => {
        socket.end(`${JSON.stringify(response)}\n`);
        if ("restart" in response) server.close(() => process.exit(0));
      });
    });
  });
  const answer = async (request: Request): Promise<Response> => {
    clearTimeout(idle);
    idle = setTimeout(() => server.close(() => process.exit(0)), IDLE_MS);
    // The editor's live view asks any Detron that's running, whichever build: it only reads.
    if (request.kind === "status") return { status: (await sessions.status()) ?? null };
    if (request.build !== build) return { restart: true }; // Detron was updated: the caller starts the new one
    if (request.kind === "ping") return { ok: true };
    if (request.kind === "tool") return { result: await sessions.tool(request.name, request.args) };
    return { reply: await sessions.handle(request.input) };
  };
  await new Promise<void>((done) => server.listen(address, done));
  idle = setTimeout(() => server.close(() => process.exit(0)), IDLE_MS);
}
