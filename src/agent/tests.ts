import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import treeKill from "tree-kill";

// The project's tests, run by Attentry at check-ins and at the end of a task: never on every edit
// (too slow). The result is evidence for the change card: passed, failed, or no tests found.

export interface TestCommand {
  cwd: string;
  command: string;
  label: string;
  runs: string; // what the command really runs (the test script's text): what the person allows
}
export interface TestRun {
  // "blocked": the person hasn't allowed these commands here yet (see trust.ts).
  state: "passed" | "failed" | "timeout" | "none" | "off" | "blocked";
  label: string; // "npm test", "backend: pytest"
  seconds: number;
  tail: string[]; // the last lines of output, when they failed
}

const NPM_DEFAULT = /no test specified/;
const TAIL_LINES = 12;
// The test runner itself is missing: not a failing test.
const NOT_INSTALLED = /No module named pytest|is not recognized as an internal or external command|command not found|ENOENT/i;

async function commandIn(dir: string): Promise<{ command: string; runs: string } | undefined> {
  const manifest = join(dir, "package.json");
  if (existsSync(manifest)) {
    try {
      const test = (JSON.parse(await readFile(manifest, "utf8")) as { scripts?: Record<string, string> }).scripts?.test;
      if (test && !NPM_DEFAULT.test(test)) {
        const runner = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : "npm";
        return { command: `${runner} test`, runs: test };
      }
    } catch {
      return undefined; // a package.json that doesn't parse has no test script we can trust
    }
  }
  const python = ["pyproject.toml", "pytest.ini", "setup.cfg", "requirements.txt"].some((f) => existsSync(join(dir, f)));
  if (python && (existsSync(join(dir, "tests")) || existsSync(join(dir, "test")))) return { command: "python -m pytest -q", runs: "python -m pytest -q" };
  return undefined;
}

// `"tests"` in .attentry/config.json: a command, or "off". Otherwise the project's own test script,
// or, in a repo of several apps (frontend/, backend/), each app's.
export async function findTests(root: string, setting: string | undefined): Promise<TestCommand[]> {
  if (setting === "off") return [];
  if (setting) return [{ cwd: root, command: setting, label: setting, runs: setting }];
  const own = await commandIn(root);
  if (own) return [{ cwd: root, ...own, label: own.command }];
  const apps: TestCommand[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const found = await commandIn(join(root, entry.name));
    if (found) apps.push({ cwd: join(root, entry.name), ...found, label: `${relative(root, join(root, entry.name))}: ${found.command}` });
  }
  return apps;
}

function runOne({ cwd, command, label }: TestCommand, timeoutMs: number): Promise<TestRun> {
  const started = Date.now();
  return new Promise((done) => {
    // A shell, since the command is a line like `npm test`. CI=1: test runners don't wait in watch mode.
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, windowsHide: true });
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-20_000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    // The whole tree: killing only the shell leaves the test runner running, holding the output open.
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) treeKill(child.pid);
    }, timeoutMs);
    const finish = (state: TestRun["state"]) => {
      clearTimeout(timer);
      const tail = state === "passed" ? [] : output.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-TAIL_LINES);
      done({ state, label, seconds: Math.round((Date.now() - started) / 1000), tail });
    };
    child.on("error", () => finish("failed"));
    child.on("close", (code) => finish(timedOut ? "timeout" : code === 0 ? "passed" : "failed"));
  });
}

// Every command, one after the other; the first that doesn't pass is the result.
export async function runTests(commands: TestCommand[], timeoutMs: number): Promise<TestRun> {
  if (!commands.length) return { state: "none", label: "", seconds: 0, tail: [] };
  let seconds = 0;
  for (const command of commands) {
    const run = await runOne(command, timeoutMs);
    seconds += run.seconds;
    if (run.state !== "passed") return { ...run, seconds };
  }
  return { state: "passed", label: commands.map((c) => c.label).join(", "), seconds, tail: [] };
}

export function describeTests(run: TestRun | undefined): string {
  if (!run) return "not run";
  if (run.state === "none") return "none found (set \"tests\" in .attentry/config.json)";
  if (run.state === "off") return "off (\"tests\": \"off\" in .attentry/config.json)";
  if (run.state === "blocked") return `not run: allow ${run.label} first (Allow tests in the Attentry sidebar)`;
  if (run.state === "passed") return `passed (${run.label}, ${run.seconds}s)`;
  if (run.state === "timeout") return `didn't finish in time (${run.label})`;
  const missing = run.tail.find((l) => NOT_INSTALLED.test(l));
  return missing ? `couldn't start (${run.label}: ${missing.trim()})` : `failed (${run.label}, ${run.seconds}s)`;
}
