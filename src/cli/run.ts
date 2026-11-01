import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectFindings } from "../findings/collect.ts";
import { formatAgent } from "../report/agent.ts";
import { formatForAgent, formatForPerson } from "../report/brief.ts";
import { explainFindings, findingsOn } from "../report/explain.ts";
import { changedLines, isInChanges } from "../scan/changes.ts";
import { formatMarkdown } from "../report/markdown.ts";
import { formatScan, scanToJson } from "../report/scan.ts";
import type { HookInput } from "../agent/hooks.ts";
import { init } from "../agent/init.ts";
import { hookReply } from "../daemon/client.ts";
import { serve } from "../daemon/server.ts";
import { runLanguageServer } from "../lsp/server.ts";
import { scanRepo } from "../scan/scan.ts";

const HELP = `Detron: stops AI coding agents from making a mess of your codebase.

Usage:
  detron scan [path]          Find security holes, crash risks, frontend/backend mismatches,
                              database issues, copied and dead code in a repo, and where
                              to clean first (default: current folder)
  detron lsp                  Run as a language server, for editors (VS Code, Cursor,
                              Windsurf, Antigravity, JetBrains, Zed, Neovim)
  detron init [path]          Set up Detron's hooks for Claude Code in a repo (Cursor and
                              Copilot CLI read them too). --mode block to also stop tasks
                              that add security or crash problems
  detron hook claude          Run as an agent hook: reads the hook's JSON on stdin, answers
                              in Claude Code's format (Cursor and Copilot CLI read it too)
  detron serve [path]         The background Detron that hooks talk to (started for you)
  detron explain <file:line>  Everything about the findings on one line: what the code
                              does, why it matters, how to fix it, how to check

Options:
  --changed             Only findings in your changes: this branch since it left main,
                        or uncommitted work on main
  --base <ref>          With --changed: compare with this branch or commit instead
  --brief               One line per finding, errors and warnings only (for agents)
  --all                 Also show hints (less certain findings)
  --agent               Findings as steps an AI agent can follow: what, why, how to fix,
                        whether it's safe, how to check
  --markdown            A report to read in a Markdown preview (VS Code, GitHub): a
                        summary, then every finding linked to its line, with the fix
  --json                The same findings, machine-readable
  --out <file>          Write the report to a file instead of printing it
                        (detron scan --markdown --out detron-report.md)
  -h, --help            Show this help
`;

type Write = (text: string) => void;

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false; // stat fails when the path doesn't exist: that's the answer, not an error
  }
}

type Format = "text" | "agent" | "json" | "brief" | "markdown";
interface ScanOptions { all: boolean; format: Format; changed: boolean; base: string | undefined }

async function scan(path: string, { all, format, changed, base }: ScanOptions, out: Write): Promise<number> {
  const root = resolve(path);
  if (!(await isFolder(root))) {
    out(`Can't scan "${path}": that folder doesn't exist.\n`);
    return 2;
  }
  const result = await scanRepo(root);
  if (format === "text" && !changed) {
    out(formatScan(result, all));
    return 0;
  }
  let findings = await collectFindings(result);
  let older = 0;
  if (changed) {
    const changes = await changedLines(root, base);
    if (!changes.ok) out(`Showing everything: can't tell what changed (${changes.reason}).\n\n`);
    const mine = findings.filter((f) => isInChanges(f, changes));
    older = findings.length - mine.length;
    findings = mine;
  }
  const shown = all ? findings : findings.filter((f) => f.confidence !== "maybe");
  if (format === "brief") out(formatForAgent(shown, `detron scan${changed ? " --changed" : ""} --agent`));
  else if (format === "text") out(formatForPerson(shown, older));
  else if (format === "agent") out(formatAgent(root, findings, all));
  else if (format === "markdown") out(formatMarkdown(findings, { root, showHints: all, older, stats: { files: result.index.files.length, functions: result.index.functions.length } }));
  else out(`${JSON.stringify(scanToJson(result, findings), null, 2)}\n`);
  return 0;
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

// An agent hook. Detron failing must not break the agent: exit 1 shows the error to the person
// without blocking the agent (exit 2 would block).
async function hook(agent: string | undefined, out: Write): Promise<number> {
  if (agent !== "claude") {
    process.stderr.write(`detron hook: unknown agent "${agent ?? ""}". Supported: claude.\n`);
    return 1;
  }
  try {
    const input = JSON.parse(await readStdin()) as HookInput;
    const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? ".");
    const reply = await hookReply(root, input);
    out(reply.stdout);
    return reply.exitCode;
  } catch (error) {
    process.stderr.write(`Detron hook failed: ${(error as Error).message}\n`);
    return 1;
  }
}

// detron explain src/routes/orders.js:9
async function explain(target: string, out: Write): Promise<number> {
  const m = /^(.+):(\d+)$/.exec(target);
  if (!m) {
    out(`Give a file and line, like src/app.ts:42.\n`);
    return 2;
  }
  const [file, line] = [m[1]!.replace(/\\/g, "/").replace(/^\.\//, ""), Number(m[2])];
  const root = resolve(".");
  const here = findingsOn(await collectFindings(await scanRepo(root)), file, line);
  out(here.length ? explainFindings(root, here) : `No findings on ${file}:${line}.\n`);
  return 0;
}

// Returns the exit code: 0 ok, 2 bad input.
export async function run(argv: string[], out: Write): Promise<number> {
  // Editors add their own flags (--stdio, --clientProcessId=123): the server reads what it
  // needs, and nothing may be printed, since stdout is the editor's channel.
  if (argv[0] === "lsp") {
    runLanguageServer(); // keeps running until the editor closes it
    return 0;
  }
  if (argv[0] === "hook") return hook(argv[1], out);
  if (argv[0] === "serve") {
    await serve(resolve(argv[1] ?? "."));
    return 0; // the server keeps the process alive until it goes idle
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        all: { type: "boolean" }, agent: { type: "boolean" }, json: { type: "boolean" }, brief: { type: "boolean" },
        changed: { type: "boolean" }, base: { type: "string" }, help: { type: "boolean", short: "h" }, mode: { type: "string" },
        markdown: { type: "boolean" }, out: { type: "string" },
      },
    });
  } catch (error) {
    out(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, path = ".", ...extra] = positionals;
  if (values.help || !command) {
    out(HELP);
    return values.help ? 0 : 2;
  }
  if (command === "explain" && !extra.length) return explain(path, out);
  if (command === "init" && !extra.length) {
    if (values.mode && values.mode !== "suggest" && values.mode !== "block") {
      out(`--mode is suggest or block, not "${values.mode}".\n`);
      return 2;
    }
    try {
      const done = await init(resolve(path), process.argv[1]!, values.mode as "suggest" | "block" | undefined);
      out(`${done.map((d) => `✓ ${d}`).join("\n")}\nStart a new Claude Code session in this repo to use them.\n`);
      return 0;
    } catch (error) {
      out(`${(error as Error).message}\n`);
      return 1;
    }
  }
  if (command === "scan" && extra.length === 1 && ["all", "agent", "json", "brief", "changed", "markdown"].includes(extra[0]!)) {
    out(`Did you mean --${extra[0]}? Options start with two dashes.\n`);
    return 2;
  }
  if (command !== "scan" || extra.length) {
    out(`Unknown command: ${positionals.join(" ")}\n\n${HELP}`);
    return 2;
  }
  const format: Format = values.json ? "json" : values.markdown ? "markdown" : values.agent ? "agent" : values.brief ? "brief" : "text";
  const options = { all: values.all ?? false, format, changed: values.changed ?? !!values.base, base: values.base };
  if (!values.out) return scan(path, options, out);
  // Written as UTF-8 by Detron itself: PowerShell's `>` would save UTF-16.
  let report = "";
  const code = await scan(path, options, (text) => (report += text));
  if (code !== 0) {
    out(report);
    return code;
  }
  try {
    await writeFile(values.out, report, "utf8");
  } catch (error) {
    out(`Can't write ${values.out}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "that folder doesn't exist" : (error as Error).message}.\n`);
    return 1;
  }
  out(`Report written to ${values.out}\n`);
  return 0;
}
