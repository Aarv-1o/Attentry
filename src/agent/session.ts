import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { collectFindings } from "../findings/collect.ts";
import type { Finding } from "../findings/types.ts";
import type { FileCache } from "../index/fileScan.ts";
import { buildIndex } from "../index/repo.ts";
import { scanRepo } from "../scan/scan.ts";
import { loadConfig, type Config } from "./config.ts";
import { describeTests, findTests, runTests, type TestRun } from "./tests.ts";
import { afterEdit, atStop, beforeEdit, contentAfter, isEdit, type HookInput, type HookReply } from "./hooks.ts";
import { findExisting, newFunctions } from "./reuse.ts";
import { startTask, type Task } from "./ledger.ts";
import { isToolName, TOOLS, type ToolResult } from "./tools.ts";

// One repo's agent sessions: each session's task, and one cache of what every file taught us,
// so a check after an edit reads only that file. Lives in the background Detron (or for one
// hook call, when that can't start).

const SILENT: HookReply = { stdout: "", exitCode: 0 };
const STOP_WAIT_MS = 45_000; // Claude Code gives a hook 60 seconds

export const greeting = (project: string, files: number, mode: string) =>
  `Detron is on for ${project} (${files} files, ${mode} mode): after each edit you'll hear about copies and new problems this task adds, and every 10 edits a check-in with the tests. If you have Detron's MCP tools, call find_existing before writing a helper.`;

export interface AgentStatus {
  edits: number;
  added: number; // problems this task has added so far
  lastEditAt: number;
  untilCheckIn: number; // edits until the next check-in
  checkInEvery: number;
  files: number; // files the task changed
  tests: { state: TestRun["state"] | "running" | "not run"; text: string };
}

export class Sessions {
  private readonly cache: FileCache = new Map();
  private readonly tasks = new Map<string, { task: Task; told: Set<string> }>();

  // `runsTests`: only the background Detron runs tests. A one-off hook process would be held
  // open by them until the agent's hook timeout kills it.
  constructor(readonly root: string, private readonly runsTests = false) {}

  // Starts the tests unless they're already running. Results land on the task.
  private startTests(task: Task, config: Config): Promise<TestRun> {
    if (task.testing) return task.testing;
    const atEdit = task.edits;
    task.testing = findTests(this.root, config.tests)
      .then((commands) => runTests(commands, config.testTimeoutSeconds * 1000))
      .then((run) => {
        task.tests = { ...run, atEdit };
        task.testsTold = false;
        return run;
      })
      .finally(() => delete task.testing);
    return task.testing;
  }

  private async findings(): Promise<Finding[]> {
    return collectFindings(await scanRepo(this.root, this.cache));
  }

  // The task starts at the session's start, or before its first edit if that came first.
  private async taskOf(session: string, findings?: Finding[]) {
    let entry = this.tasks.get(session);
    if (!entry) this.tasks.set(session, (entry = { task: startTask(findings ?? (await this.findings())), told: new Set() }));
    return entry;
  }

  private latestTask(): Task | undefined {
    return [...this.tasks.values()].map((e) => e.task).sort((a, b) => b.lastEditAt - a.lastEditAt)[0];
  }

  // A tool an agent called (MCP). Tools don't say which session they're from: "this task" is
  // the one that edited most recently.
  async tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!isToolName(name)) return { text: `Unknown tool: ${name}.`, isError: true };
    return TOOLS[name](args, {
      root: this.root,
      index: () => buildIndex(this.root, this.cache),
      findings: () => this.findings(),
      task: () => this.latestTask(),
    });
  }

  // The most recently active agent task, for the editor: no scan, just what's known.
  async status(): Promise<AgentStatus | undefined> {
    const latest = this.latestTask();
    if (!latest) return undefined;
    const every = (await loadConfig(this.root)).checkInEvery;
    const tests = latest.testing ? { state: "running" as const, text: "running…" } : latest.tests ? { state: latest.tests.state, text: describeTests(latest.tests) } : { state: "not run" as const, text: "not run yet (they run at the first check-in)" };
    return { edits: latest.edits, added: latest.added, lastEditAt: latest.lastEditAt, untilCheckIn: every - (latest.edits - latest.lastCheckIn), checkInEvery: every, files: latest.editedFiles.size, tests };
  }

  // New functions in what the agent is about to write that the repo already has.
  private async reuseCheck(input: HookInput, told: Set<string>): Promise<HookReply> {
    const path = input.tool_input?.file_path;
    if (!path) return SILENT;
    const before = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""; // a new file
      throw error;
    });
    const after = contentAfter(input, before);
    if (after === undefined) return SILENT;
    const candidates = await newFunctions(path, before, after);
    if (!candidates.length) return SILENT;
    const file = relative(this.root, path).replace(/\\/g, "/");
    const matches = findExisting(candidates, await buildIndex(this.root, this.cache), file, input.tool_name === "Write");
    return beforeEdit(matches, told, await loadConfig(this.root));
  }

  async handle(input: HookInput): Promise<HookReply> {
    const event = input.hook_event_name;
    if (event === "SessionStart") {
      this.tasks.delete(input.session_id); // a new or cleared conversation is a new task
      await this.taskOf(input.session_id);
      // One line, once per session, so the agent (and the person asking it) knows Detron is on.
      const files = (await buildIndex(this.root, this.cache)).files.length;
      return { stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: greeting(basename(this.root), files, (await loadConfig(this.root)).mode) } })}\n`, exitCode: 0 };
    }
    if (event === "PreToolUse" && isEdit(input)) {
      const { told } = await this.taskOf(input.session_id);
      return this.reuseCheck(input, told);
    }
    if (event === "PostToolUse" && isEdit(input)) {
      const { task, told } = await this.taskOf(input.session_id);
      const config = await loadConfig(this.root);
      const checkIns = task.lastCheckIn;
      const reply = afterEdit(input, this.root, task, told, await this.findings(), config);
      // A check-in: the tests, in the background (the agent doesn't wait).
      if (this.runsTests && task.lastCheckIn !== checkIns) void this.startTests(task, config);
      return reply;
    }
    if (event === "Stop") {
      const entry = this.tasks.get(input.session_id);
      if (!entry) return SILENT; // nothing was edited in this session
      const config = await loadConfig(this.root);
      // The card's evidence: tests run on the final code, waited for as long as the hook may take.
      if (this.runsTests && entry.task.edits && (entry.task.tests?.atEdit ?? -1) < entry.task.edits) {
        await Promise.race([this.startTests(entry.task, config), new Promise((wait) => setTimeout(wait, STOP_WAIT_MS))]);
      }
      return atStop(input, entry.task, await this.findings(), config);
    }
    return SILENT;
  }
}
