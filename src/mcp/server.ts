import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { MCP_SESSION } from "../agent/session.ts";
import type { ToolResult } from "../agent/tools.ts";
import { beginTask, toolReply } from "../daemon/client.ts";

// `attentry mcp`: Attentry's tools for any agent that speaks MCP (Claude Code, Cursor, Codex,
// Gemini CLI, Copilot, Windsurf, Cline...). The official SDK speaks the protocol, old handshake
// and new revisions alike, and checks every call's arguments against the schemas below, so a
// wrong call comes back as an error the agent can read and fix. The answers come from the repo's
// background Attentry, the one hooks ask, so tools and hooks see the same cache.

const INSTRUCTIONS = `Attentry knows this repo: every function, route and known problem.
- Before writing a helper or utility: call find_existing. The repo may already have it; reuse it instead of adding a copy.
- After changing code, before saying you're done: call check. It lists problems your changes added, marked "(new in this task)".
- For the full fix of one finding: call explain with its file:line.`;

// Limits on what an agent sends. More isn't a question Attentry can help with, and it would sit in memory.
const PATH = z.string().min(1).max(1_000);
const MAX_INPUT_ELEMENTS = 1_000;

const TOOLS = {
  find_existing: {
    title: "Find an existing function",
    description:
      "Call before writing a function: does the repo already have one that does the job? Give `query` (what it should do, in a few words) or `code` (the function you're about to write, with `file`). Answers with matching functions, their file:line, how often they're used, and whether to import them. Answers \"nothing like it\" when you should go ahead.",
    inputSchema: z
      .object({
        query: z.string().max(500).optional().describe('What the function should do, in a few words: "format a date as time ago".'),
        code: z.string().max(200_000).optional().describe("The function you're about to write. Give `file` too, so it's compared the way Attentry compares copies."),
        file: PATH.optional().describe("With `code`: the repo-relative file it will go in, like src/utils/date.ts."),
        language: z.enum(["js", "jsx", "ts", "tsx", "py", "javascript", "typescript", "python"]).optional().describe("With `code` and no `file`: the language it's in."),
      })
      .refine((a) => a.query?.trim() || a.code?.trim(), "Give `query` (what the function should do) or `code` (the function you're about to write)."),
  },
  check: {
    title: "Check for problems",
    description:
      "Call after a change, before saying you're done. Lists problems in your changes (default) or in the `files` you give: security holes, crash risks, broken frontend/backend calls, database issues, then clean-up (copied and unused code). Problems your task added are marked \"(new in this task)\": fix those first. Each line is file:line severity rule: message.",
    inputSchema: z.object({
      files: z.array(PATH).max(200).optional().describe("Repo-relative files to check, like [\"src/app.ts\"]. Leave out to check your changes."),
    }),
  },
  explain: {
    title: "Explain a finding",
    description:
      "Everything about the findings on one line: what the code does, why it matters, the fix in steps, whether it's safe to do without asking the person, and how to check it worked. Use it on a file:line from check.",
    inputSchema: z.object({
      location: z.string().max(1_000).regex(/^.+:\d+$/, "Give `location` as file:line, like src/app.ts:42.").describe("file:line, like src/app.ts:42."),
    }),
  },
} as const;

const asResult = ({ text, isError }: ToolResult) => ({ content: [{ type: "text" as const, text }], isError: !!isError });

// Reads stdin until the agent closes it. Nothing else may go to stdout: it's the agent's channel.
export function runMcpServer(root: string): void {
  // One MCP server per agent session: its task starts now, so "new in this task" means since then.
  const session = `${MCP_SESSION}${process.pid}`;
  const begun = beginTask(root, session).catch(() => undefined); // no background Attentry: tools still answer
  const call = async (name: string, args: Record<string, unknown>) => {
    try {
      await begun;
      return asResult(await toolReply(root, name, args, session));
    } catch (error) {
      // A failed tool is a result the agent can read, not a broken connection.
      return asResult({ text: `Attentry failed: ${(error as Error).message}`, isError: true });
    }
  };
  const annotations = { readOnlyHint: true, openWorldHint: false }; // reads the repo, changes nothing
  serveStdio(() => {
    const server = new McpServer({ name: "attentry", version: manifest.version }, { instructions: INSTRUCTIONS, maxToolInputElements: MAX_INPUT_ELEMENTS });
    server.registerTool("find_existing", { ...TOOLS.find_existing, annotations }, (args) => call("find_existing", args));
    server.registerTool("check", { ...TOOLS.check, annotations }, (args) => call("check", args));
    server.registerTool("explain", { ...TOOLS.explain, annotations }, (args) => call("explain", args));
    return server;
  }, { onerror: (error) => process.stderr.write(`attentry mcp: ${error.message.replace(/\s+/g, " ").slice(0, 300)}\n`) }); // a message that isn't MCP: noted, then ignored
}
