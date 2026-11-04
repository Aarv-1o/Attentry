import { rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import type { HookInput, HookReply } from "../agent/hooks.ts";
import { Sessions, type AgentStatus } from "../agent/session.ts";
import type { ToolResult } from "../agent/tools.ts";
import { addressFor, buildId, sign } from "./address.ts";

// `detron serve`: the background Detron for one repo. Hooks and MCP tools ask it instead of
// scanning from scratch: it keeps what each file taught us in memory, and each agent session's
// task. Nothing is written to disk. It stops after a quiet half hour.

export type Request =
  | { kind: "hook"; build: string; input: HookInput }
  | { kind: "tool"; build: string; name: string; args: Record<string, unknown>; session?: string | undefined }
  | { kind: "begin"; build: string; session: string }
  | { kind: "ping"; build: string }
  | { kind: "status" };
export type Response =
  | { reply: HookReply } | { result: ToolResult } | { ok: true } | { restart: true } | { error: string } | { status: AgentStatus | null };

const IDLE_MS = 30 * 60 * 1000;
const MAX_REQUEST = 8 * 1024 * 1024; // a hook's whole Write content fits; anything bigger isn't Detron's

// Is something already answering there? A socket file left by a crash is not.
const answering = (address: string) => new Promise<boolean>((done) => {
  const probe = createConnection(address, () => (probe.end(), done(true)));
  probe.on("error", () => done(false));
});

export async function serve(root: string): Promise<void> {
  const address = addressFor(root);
  if (await answering(address)) return; // another one got there first: it serves this repo
  if (process.platform !== "win32") rmSync(address, { force: true }); // left by a crash
  const sessions = new Sessions(root, true); // long-lived: it reads the repo in the background and runs the tests
  const build = buildId();
  let queue = Promise.resolve();
  let idle: NodeJS.Timeout;
  const stayAwake = () => {
    clearTimeout(idle);
    idle = setTimeout(() => server.close(() => process.exit(0)), IDLE_MS);
  };
  // One request per connection: a line of JSON in, a line of JSON out.
  const server = createServer((socket: Socket) => {
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0 && text.length <= MAX_REQUEST) return;
      socket.off("data", onData);
      let request: Request & { nonce?: unknown };
      try {
        if (end < 0) throw new Error("request too large");
        request = JSON.parse(text.slice(0, end)) as Request & { nonce?: unknown };
      } catch (error) {
        socket.end(`${JSON.stringify({ error: `bad request: ${(error as Error).message}` })}\n`);
        return;
      }
      // Proof for the caller that this is Detron, not something else holding its address.
      const seal = typeof request.nonce === "string" ? sign(request.nonce) : undefined;
      // One at a time: requests share the cache and the tasks.
      queue = queue.then(() => answer(request)).catch((error: Error) => ({ error: error.stack ?? String(error) })).then((response: Response) => {
        socket.end(`${JSON.stringify({ ...response, seal })}\n`);
        if ("restart" in response) server.close(() => process.exit(0));
      });
    };
    socket.on("data", onData);
    socket.on("error", () => undefined); // the caller went away: nothing to answer
  });
  const answer = async (request: Request): Promise<Response> => {
    stayAwake();
    // The editor's live view asks any Detron that's running, whichever build: it only reads.
    if (request.kind === "status") return { status: (await sessions.status()) ?? null };
    if (request.build !== build) return { restart: true }; // Detron was updated: the caller starts the new one
    if (request.kind === "ping") return { ok: true };
    if (request.kind === "begin") return (await sessions.begin(request.session), { ok: true });
    if (request.kind === "tool") return { result: await sessions.tool(request.name, request.args, request.session) };
    return { reply: await sessions.handle(request.input) };
  };
  await new Promise<void>((done) => server.listen(address, done));
  stayAwake();
  void sessions.readRepo(); // started by an agent's first hook: it will want the repo read
}
