import { createInterface } from "node:readline";
import type { ToolResult } from "../agent/tools.ts";
import manifest from "../../package.json" with { type: "json" };

// `detron mcp`: Detron's tools for any agent that speaks MCP (Claude Code, Cursor, Codex,
// Gemini CLI, Copilot, Windsurf, Cline...). MCP over stdio is JSON-RPC, one message per line;
// the part agents use (initialize, tools/list, tools/call, ping) is small enough to need no SDK.
// The answers come from the repo's background Detron, the one hooks ask, so tools see the same
// cache and the same "new in this task" list.

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Detron knows this repo: every function, route and known problem.
Before writing a helper, call find_existing: the repo may already have it.
After a change, call check to see the problems it added. explain gives the full fix for one file:line.`;

export const TOOL_LIST = [
  {
    name: "find_existing",
    title: "Find an existing function",
    description:
      "Before writing a function, ask whether the repo already has one that does the job. Give `query` (what it should do, like \"format a date as time ago\") or `code` (the function you're about to write, with `file` where it will go). Returns matching functions with their file:line and how to reuse them.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the function should do, in a few words." },
        code: { type: "string", description: "The function you're about to write." },
        file: { type: "string", description: "With `code`: the file it will go in (decides the language and which app it belongs to)." },
        language: { type: "string", description: "With `code` and no `file`: js, ts or py." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "check",
    title: "Check for problems",
    description:
      "Problems in your changes (the default) or in the files you list: security holes, crash risks, broken frontend/backend calls, database issues, copied and dead code. Marks the ones this task added. Call it after a change, before saying you're done.",
    inputSchema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" }, description: "Files to check, relative to the repo. Leave out to check your changes." } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "explain",
    title: "Explain a finding",
    description: "Everything about the findings on one line: what the code does, why it matters, how to fix it, whether it's safe to fix alone, and how to check.",
    inputSchema: {
      type: "object",
      properties: { location: { type: "string", description: "file:line, like src/app.ts:42." } },
      required: ["location"],
    },
    annotations: { readOnlyHint: true },
  },
];

type Message = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Call = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

// One request in, the response out (undefined for notifications, which get none).
export async function handleMessage(message: Message, call: Call): Promise<object | undefined> {
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return undefined; // a notification (initialized, cancelled)
  const reply = (result: object) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "detron", version: manifest.version },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOL_LIST });
    case "tools/call": {
      const name = String(params.name ?? "");
      if (!TOOL_LIST.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      try {
        const { text, isError } = await call(name, args);
        return reply({ content: [{ type: "text", text }], isError: !!isError });
      } catch (error) {
        // A failed tool is a result the agent can read, not a broken connection.
        return reply({ content: [{ type: "text", text: `Detron failed: ${(error as Error).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

// Reads messages from stdin until it closes. Nothing else may go to stdout: it's the agent's channel.
export function runMcpServer(call: Call): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let pending = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    // In order, one at a time: a tool's scan fills the cache the next one uses.
    pending = pending.then(async () => {
      const response = await handleMessage(message, call);
      if (response) send(response);
    });
  });
  return new Promise((done) => lines.on("close", () => void pending.then(done)));
}
