import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { collectFindings } from "../findings/collect.ts";
import type { Finding } from "../findings/types.ts";
import type { FileCache } from "../index/fileScan.ts";
import { isSource, listRepoFiles } from "../index/files.ts";
import { buildIndex, type RepoIndex } from "../index/repo.ts";
import { plural } from "../report/common.ts";
import { scanRepo } from "../scan/scan.ts";
import { loadConfig, type Config } from "./config.ts";
import { describeTests, findTests, runTests, type TestRun } from "./tests.ts";
import { afterEdit, atStop, beforeEdit, beforePlan, contentAfter, editsOf, firstCheckIn, isEdit, isPlanFile, nextCheckIn, noteEdit, outsideProject, repoPath, UNPLANNED, type FileEdit, type HookInput, type HookReply, type PlanReview } from "./hooks.ts";
import { reviewPlan } from "./plan.ts";
import { readTexts } from "../index/texts.ts";
import type { FullRoute } from "../rules/crossStack/resolve.ts";
import { routeCoverage } from "../testing/coverage.ts";
import { planSteps, type PlanStep } from "../testing/steps.ts";
import { plannedWritten, suggestTests, type PlannedRoute } from "../testing/suggest.ts";
import { relatedCode, relatedMessage } from "./related.ts";
import { findExisting, newFunctions, type ExistingMatch } from "./reuse.ts";
import { recordStart, startTask, type Task } from "./ledger.ts";
import { testsAllowed } from "./trust.ts";
import { isToolName, TOOLS, type ToolResult } from "./tools.ts";

// One repo's agent sessions: each session's task, and one cache of what every file taught us,
// so a check after an edit reads only that file. Lives in the background Attentry (or for one
// hook call, when that can't start).

const SILENT: HookReply = { stdout: "", exitCode: 0 };
const STOP_WAIT_MS = 45_000; // Claude Code gives a hook 60 seconds
const ACTIVE_MS = 30 * 60 * 1000; // an agent that edited within this is still working

// A checked plan, from plan mode or the check_plan tool: its test suggestions stand in for the
// check-ins', and a new plan starts its steps over (one without steps keeps the regular check-ins).
function planHeard(task: Task, review: { steps: PlanStep[]; planned: PlannedRoute[] }): void {
  task.planHeard = true;
  if (review.steps.length) [task.steps, task.step] = [review.steps, 0];
  if (review.planned.length) task.plannedTests = review.planned;
}
const READ_WAIT_MS = 2_000; // a small repo is read by then: it answers as if it always had been
const READING = "reading"; // the agent heard that Attentry is still reading the repo
const OUTSIDE = "outside"; // the agent heard that its edits outside the project aren't checked
// MCP sessions are named by Attentry's MCP server, one per agent session: never a hook's session id.
export const MCP_SESSION = "mcp:";

// `tests`: what the check-ins will do with the tests, from testsPromise.
export const greeting = (project: string, files: number, config: Config, tests: string) =>
  `Attentry is on for ${project} (${plural(files, "file")}, ${config.mode} mode): after each edit you'll hear about copies and new problems this task adds, and a check-in after ${firstCheckIn(config.checkInEvery)} edits, then every ${config.checkInEvery}.${tests} If you have Attentry's MCP tools, call find_existing before writing a helper.`;

const routeKey = (r: FullRoute) => `${r.method} ${r.path.text}`;

const tell = (event: string, text: string): HookReply =>
  ({ stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`, exitCode: 0 });

// "about 40 s", "about 3 min".
const about = (ms: number) => (ms < 90_000 ? `about ${Math.ceil(ms / 1000)} s` : `about ${Math.round(ms / 60_000)} min`);

export interface AgentStatus {
  edits: number;
  added: number; // problems this task has added so far
  lastEditAt: number;
  untilCheckIn: number; // edits until the next check-in
  checkInEvery: number; // edits from the last check-in to the next (the first comes sooner)
  files: number; // files the task changed
  tests: { state: TestRun["state"] | "running" | "not run"; text: string };
  agent: "claude" | "codex";
}

export class Sessions {
  private readonly cache: FileCache = new Map();
  private readonly tasks = new Map<string, { task: Task; told: Set<string> }>();
  // The first scan, which reads every file (minutes on a big repo), and the tasks that began
  // during it: what they started with is filled in when it ends.
  private reading?: Promise<void>;
  private read = false;
  private readStart = 0;
  private sourceFiles = 0;
  private readonly unstarted = new Set<Task>();

  // `background`: the long-lived Attentry. Only it runs tests (a one-off hook process would be held
  // open by them until the agent's hook timeout kills it) and reads the repo while hooks answer.
  constructor(readonly root: string, private readonly background = false, private readonly readWaitMs = READ_WAIT_MS) {}

  // Starts the first scan. Hooks don't wait for it, so on a big repo the agent never does
  // (and Claude Code never times a hook out).
  readRepo(): Promise<void> {
    this.reading ??= (async () => {
      this.readStart = Date.now();
      this.sourceFiles = (await listRepoFiles(this.root)).filter(isSource).length;
      const [findings, routes] = await this.startingPoint();
      for (const task of this.unstarted) recordStart(task, findings, routes);
      this.unstarted.clear();
    })()
      .catch(() => undefined) // a scan that failed fails again, with its error, on the next check
      .finally(() => (this.read = true));
    return this.reading;
  }

  // Can this answer use the scan? Waits a moment for the first one: a small repo is read by then.
  private async ready(): Promise<boolean> {
    if (!this.background || this.read) return true;
    await Promise.race([this.readRepo(), new Promise((wait) => setTimeout(wait, this.readWaitMs))]);
    return this.read;
  }

  // "40% of 9,000 files, about 1 min left". The rules after the files take a while too: never 100%.
  private progress(): string {
    const done = Math.min(this.cache.size, this.sourceFiles);
    const percent = this.sourceFiles ? Math.min(99, Math.floor((done / this.sourceFiles) * 100)) : 0;
    const left = done ? `, ${about(((this.sourceFiles - done) * (Date.now() - this.readStart)) / done)} left` : "";
    return `${percent}% of ${plural(this.sourceFiles, "file")}${left}`;
  }

  // The greeting promises only what the check-ins will really do with the tests: a promise of
  // tests that then never run leaves the agent thinking they passed.
  private async testsPromise(config: Config): Promise<string> {
    if (!this.background || config.tests === "off") return ""; // only the background Attentry runs them
    const commands = await findTests(this.root, config.tests);
    if (!commands.length) return " This project has no tests yet.";
    const label = commands.map((c) => c.label).join(", ");
    return (await testsAllowed(this.root, commands))
      ? ` The check-ins run the tests (${label}).`
      : ` The check-ins will run the tests (${label}) once the person allows them in the Attentry sidebar.`;
  }

  // Only commands the person allowed for this repo run: a cloned repo's test script could be anything.
  private async testRun(config: Config): Promise<TestRun> {
    if (config.tests === "off") return { state: "off", label: "", seconds: 0, tail: [] };
    const commands = await findTests(this.root, config.tests);
    if (commands.length && !(await testsAllowed(this.root, commands))) return { state: "blocked", label: commands.map((c) => c.label).join(", "), seconds: 0, tail: [] };
    return runTests(commands, config.testTimeoutSeconds * 1000);
  }

  // Starts the tests unless they're already running. Results land on the task.
  private startTests(task: Task, config: Config): Promise<TestRun> {
    if (task.testing) return task.testing;
    const atEdit = task.edits;
    task.testing = this.testRun(config)
      // The output is for the panel's own runs: a task keeps only the tail.
      .then(({ output: _, ...run }) => {
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

  // What a task starts with: the repo's findings, and its routes.
  private async startingPoint(): Promise<[Finding[], string[]]> {
    const scan = await scanRepo(this.root, this.cache);
    return [await collectFindings(scan), scan.crossStack.allRoutes.map(routeKey)];
  }

  // The task starts at the session's start, or before its first edit if that came first. `agent`:
  // whose hooks asked, when they say.
  private async taskOf(session: string, agent?: Task["agent"]) {
    let entry = this.tasks.get(session);
    if (!entry) {
      let task: Task;
      if (this.background && !this.read) this.unstarted.add((task = startTask()));
      else task = startTask(...(await this.startingPoint()));
      this.tasks.set(session, (entry = { task, told: new Set() }));
    }
    if (agent) entry.task.agent = agent;
    return entry;
  }

  private latestTask(): Task | undefined {
    return [...this.tasks.values()].map((e) => e.task).sort((a, b) => b.lastEditAt - a.lastEditAt)[0];
  }

  private hookTasks(): Task[] {
    return [...this.tasks].filter(([session]) => !session.startsWith(MCP_SESSION)).map(([, e]) => e.task);
  }

  // Is another agent editing this repo too? Then each task owns only the files it edited.
  private markShared(task: Task): void {
    task.shared = this.hookTasks().some((other) => other !== task && Date.now() - other.lastEditAt < ACTIVE_MS);
  }

  // An MCP server starting: what the repo has now is where its task starts.
  async begin(session: string): Promise<void> {
    await this.taskOf(session);
  }

  // A tool an agent called (MCP). MCP doesn't say which hook session it belongs to: with one
  // agent's hooks running, that's its task; otherwise the MCP server's own, from when it started.
  async tool(name: string, args: Record<string, unknown>, session?: string): Promise<ToolResult> {
    if (!isToolName(name)) return { text: `Unknown tool: ${name}.`, isError: true };
    if (!(await this.ready())) return { text: `Attentry is still reading this repo (${this.progress()}). Ask again then.` };
    const hooks = this.hookTasks();
    const task = hooks.length === 1 ? hooks[0] : session ? this.tasks.get(session)?.task : undefined;
    return TOOLS[name](args, {
      root: this.root,
      index: () => buildIndex(this.root, this.cache),
      findings: () => this.findings(),
      task: () => task,
      // Codex has no plan mode: this tool is how its plans get checked, so the task hears it too.
      reviewPlan: async (plan) => {
        const review = await this.reviewPlan(plan);
        if (task) planHeard(task, review);
        return review;
      },
    });
  }

  // Every finding in the repo, for the editor. While the first scan reads, how far it got: the
  // editor asks again later, so hooks never queue behind it.
  async repoFindings(): Promise<{ findings: Finding[] } | { reading: string }> {
    void this.readRepo();
    return this.read ? { findings: await this.findings() } : { reading: this.progress() };
  }

  // The most recently active agent task, for the editor: no scan, just what's known.
  async status(): Promise<AgentStatus | undefined> {
    const latest = this.latestTask();
    if (!latest) return undefined;
    const every = (await loadConfig(this.root)).checkInEvery;
    const tests = latest.testing ? { state: "running" as const, text: "running…" } : latest.tests ? { state: latest.tests.state, text: describeTests(latest.tests) } : { state: "not run" as const, text: "not run yet (they run at the first check-in)" };
    const next = nextCheckIn(latest, every);
    return { edits: latest.edits, added: latest.added, lastEditAt: latest.lastEditAt, untilCheckIn: next - latest.edits, checkInEvery: next - latest.lastCheckIn, files: latest.editedFiles.size, tests, agent: latest.agent ?? "claude" };
  }

  // New functions in what the agent is about to write that the repo already has.
  private async reuseCheck(edits: FileEdit[], told: Set<string>): Promise<HookReply> {
    const matches: ExistingMatch[] = [];
    let index: Promise<RepoIndex> | undefined; // built once, and only if a file adds functions
    for (const edit of edits) {
      const before = await readFile(edit.path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""; // a new file
        throw error;
      });
      const after = contentAfter(edit, before);
      if (after === undefined) continue;
      const candidates = await newFunctions(edit.path, before, after);
      if (!candidates.length) continue;
      index ??= buildIndex(this.root, this.cache);
      matches.push(...findExisting(candidates, await index, repoPath(this.root, edit.path), edit.write !== undefined));
    }
    return matches.length ? beforeEdit(matches, told, await loadConfig(this.root)) : SILENT;
  }

  // No plan said which tests this task needs (vibe coders rarely plan, and need it most): at a
  // check-in, the plan check's suggestions for the routes it added that no test reaches. Worked out
  // only when this edit brings a check-in.
  private async unplannedTests(task: Task, told: Set<string>, edits: FileEdit[], config: Config): Promise<string[]> {
    if (task.planHeard || told.has(UNPLANNED) || !config.testSuggestions || task.edits + 1 < nextCheckIn(task, config.checkInEvery)) return [];
    const scan = await scanRepo(this.root, this.cache);
    const coverage = routeCoverage(scan.index);
    const edited = new Set([...task.editedFiles, ...edits.map((e) => repoPath(this.root, e.path))]);
    const routes = coverage.filter((c) => !c.tests.length && edited.has(c.route.file)).map((c) => routeKey(c.route)).filter((r) => !task.routesAtStart.has(r));
    if (!routes.length) return [];
    return suggestTests(routes.join("\n"), scan, coverage, await readTexts(this.root, scan.index.files)).lines;
  }

  // A plan, from ExitPlanMode or its file: notes it hasn't heard yet this session (writing the
  // plan file and then finishing the plan shouldn't say the same thing twice).
  private async planCheck(session: string, plan: string | undefined, event: "PreToolUse" | "PostToolUse"): Promise<HookReply> {
    if (!plan || !(await this.ready())) return SILENT; // a plan isn't held up for the first read
    const { task, told } = await this.taskOf(session);
    const review = await this.reviewPlan(plan);
    planHeard(task, review);
    const fresh = (lines: string[]) => lines.filter((line) => !told.has(`plan:${line}`));
    const unheard = { notes: fresh(review.notes), tests: fresh(review.tests) };
    for (const line of [...unheard.notes, ...unheard.tests]) told.add(`plan:${line}`);
    return beforePlan(unheard, event);
  }

  private async reviewPlan(plan: string): Promise<PlanReview & { steps: PlanStep[]; planned: PlannedRoute[] }> {
    const scan = await scanRepo(this.root, this.cache);
    // Switched off in the panel or .attentry/config.json: no tests in the plan message or on the card.
    const suggested = (await loadConfig(this.root)).testSuggestions
      ? suggestTests(plan, scan, routeCoverage(scan.index), await readTexts(this.root, scan.index.files))
      : { lines: [], routes: [] };
    return {
      notes: reviewPlan(plan, scan, await collectFindings(scan)),
      tests: suggested.lines,
      planned: suggested.routes,
      steps: planSteps(plan, new Set(scan.index.allFiles)),
    };
  }

  // A request from the person: the related code Claude hasn't heard about yet this session, so it
  // plans with it. Not held up for the first read, and a scan of a read repo takes no time.
  private async relatedTo(session: string, prompt: string | undefined): Promise<HookReply> {
    if (!prompt || !(await this.ready())) return SILENT;
    const { told } = await this.taskOf(session);
    const items = relatedCode(prompt, await scanRepo(this.root, this.cache)).filter((item) => !told.has(`related:${item}`));
    for (const item of items) told.add(`related:${item}`);
    return items.length ? tell("UserPromptSubmit", relatedMessage(items)) : SILENT;
  }

  // Code written outside the project goes unchecked: said once a session, so neither the agent nor
  // the person assumes Attentry is checking it. Only code: an agent's own notes and settings live
  // outside every project.
  private async outsideNote(input: HookInput, edits: FileEdit[]): Promise<HookReply> {
    const code = edits.find((edit) => isSource(edit.path));
    if (!code) return SILENT;
    const { told } = await this.taskOf(input.session_id, input.agent);
    if (told.has(OUTSIDE)) return SILENT;
    told.add(OUTSIDE);
    const name = basename(this.root);
    return tell("PostToolUse", `Attentry: ${code.path} is outside ${name} (${this.root}), the project Attentry checks, so it isn't checking edits there. Tell the person: to have Attentry check that folder, open it in the editor.`);
  }

  async handle(input: HookInput): Promise<HookReply> {
    const event = input.hook_event_name;
    if (event === "UserPromptSubmit") return this.relatedTo(input.session_id, input.prompt);
    if (event === "SessionStart") {
      // A new or cleared conversation is a new task. A resumed or compacted one carries on: starting
      // over would forget its plan and count the problems it added so far as already there.
      if (input.source !== "resume" && input.source !== "compact") this.tasks.delete(input.session_id);
      const ready = await this.ready();
      await this.taskOf(input.session_id, input.agent);
      // One line, once per session, so the agent (and the person asking it) knows Attentry is on.
      const config = await loadConfig(this.root);
      const tests = await this.testsPromise(config);
      if (!ready) return tell(event, `${greeting(basename(this.root), this.sourceFiles, config, tests)} First it reads the repo (${this.progress()}): edits until then are checked once it's done.`);
      return tell(event, greeting(basename(this.root), (await buildIndex(this.root, this.cache)).files.length, config, tests));
    }
    if (event === "PreToolUse" && input.tool_name === "ExitPlanMode") return this.planCheck(input.session_id, input.tool_input?.plan, event);
    // Outside the project: not this task's edit. A plan file is checked as a plan.
    const all = editsOf(input);
    const edits = all.filter((edit) => !outsideProject(this.root, edit.path));
    if (all.length && !edits.length) {
      const plan = all.find((edit) => isPlanFile(edit.path));
      if (event !== "PostToolUse") return SILENT;
      if (plan) return this.planCheck(input.session_id, await readFile(plan.path, "utf8").catch(() => undefined), event);
      return this.outsideNote(input, all);
    }
    if (event === "PreToolUse" && isEdit(input)) {
      if (!(await this.ready())) return SILENT; // the reuse check needs every function in the repo
      const { told } = await this.taskOf(input.session_id, input.agent);
      return this.reuseCheck(edits, told);
    }
    if (event === "PostToolUse" && isEdit(input)) {
      const ready = await this.ready();
      const { task, told } = await this.taskOf(input.session_id, input.agent);
      if (!ready) {
        // Counted now, checked after the first scan: the next edit then hears what this one added.
        noteEdit(edits, this.root, task);
        if (told.has(READING)) return SILENT;
        told.add(READING);
        return tell(event, `Attentry is still reading the repo (${this.progress()}). It checks this task's edits once it's done.`);
      }
      const config = await loadConfig(this.root);
      this.markShared(task);
      const checkIns = task.lastCheckIn;
      const unplanned = await this.unplannedTests(task, told, edits, config);
      const reply = afterEdit(edits, this.root, task, told, await this.findings(), config, unplanned);
      // A check-in: the tests, in the background (the agent doesn't wait).
      if (this.background && task.lastCheckIn !== checkIns) void this.startTests(task, config);
      return reply;
    }
    if (event === "Stop") {
      const entry = this.tasks.get(input.session_id);
      if (!entry) return SILENT; // nothing was edited in this session
      if (!(await this.ready())) return SILENT; // no card yet: finishing doesn't wait for the first scan
      const config = await loadConfig(this.root);
      this.markShared(entry.task);
      // The card's evidence: tests run on the final code, waited for as long as the hook may take.
      if (this.background && entry.task.edits && (entry.task.tests?.atEdit ?? -1) < entry.task.edits) {
        await Promise.race([this.startTests(entry.task, config), new Promise((wait) => setTimeout(wait, STOP_WAIT_MS))]);
      }
      const scan = await scanRepo(this.root, this.cache);
      const { plannedTests } = entry.task;
      const planned = plannedTests ? { ...plannedWritten(plannedTests, routeCoverage(scan.index), entry.task.editedFiles), total: plannedTests.length } : undefined;
      return atStop(input, this.root, entry.task, await collectFindings(scan), config, planned);
    }
    return SILENT;
  }
}
