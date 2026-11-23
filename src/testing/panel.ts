import { basename } from "node:path";
import { loadConfig } from "../agent/config.ts";
import { findTests, runTests, type TestCommand, type TestRun } from "../agent/tests.ts";
import { testsAllowed } from "../agent/trust.ts";
import type { FileCache } from "../index/fileScan.ts";
import { buildIndex } from "../index/repo.ts";
import { escapeRegex, readTexts } from "../index/texts.ts";
import { AUTH_GUARD, PUBLIC_PATH } from "../rules/security/endpoints.ts";
import { changedLines } from "../scan/changes.ts";
import { routeCoverage } from "./coverage.ts";
import { commandFor, testFiles, testsFor } from "./select.ts";

// The panel's Tests section: routes no test reaches, worst first, the last run, and the run
// button with its menu (all, the open file's, the changed files', one test file). Runs only test
// commands the person allowed.

// A failing test and where it's written, when Attentry finds its name in a test file.
export interface FailingTest { name: string; file?: string; line?: number }
export type PanelRun = TestRun & { scope: string; failingAt?: FailingTest[] };

export interface TestsView {
  suggestions: boolean; // the plan check's test suggestions are on
  routes: number; // routes found
  untested: { method: string; path: string; file: string; line: number; open: boolean }[]; // open: no auth check on it
  last: (PanelRun & { at: number }) | null;
}

// What to run. `files`: project paths (the open file, or a test file picked from the menu);
// `name` says it on the panel.
export type RunScope = { kind: "all" } | { kind: "changed" } | { kind: "files"; files: string[]; name: string };

// The run menu's choices, with what each would run.
export interface TestChoices {
  command: string; // "npm test", or "" when the project has none
  open?: { file: string; tests: number }; // the editor's open file, when it's in the project
  changed?: number; // test files for what git says changed; undefined outside git
  files: string[]; // every test file, for "Choose a test file…"
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL"]);
const SHOWN_FAILING = 3;

export async function testsView(root: string, cache: FileCache, last: TestsView["last"]): Promise<TestsView> {
  const coverage = routeCoverage(await buildIndex(root, cache));
  // A route with no auth check that changes data first: the costliest to leave untested.
  const rank = (r: { open: boolean; method: string }) => (r.open ? 0 : 2) + (WRITE.has(r.method) ? 0 : 1);
  const untested = coverage
    .filter((c) => !c.tests.length && !c.route.path.unknownPrefix)
    .map(({ route: r }) => ({ method: r.method, path: r.path.text, file: r.file, line: r.line, open: !PUBLIC_PATH.test(r.path.text) && !r.guards.some((g) => AUTH_GUARD.test(g)) }))
    .sort((a, b) => rank(a) - rank(b));
  return { suggestions: (await loadConfig(root)).testSuggestions, routes: coverage.length, untested, last };
}

// The files git says changed (committed on this branch, or not yet), as project paths.
async function changedFiles(root: string): Promise<string[] | undefined> {
  const changes = await changedLines(root);
  return changes.ok ? [...changes.files.keys()] : undefined;
}

export async function testChoices(root: string, cache: FileCache, openFile: string | undefined): Promise<TestChoices> {
  const index = await buildIndex(root, cache);
  const commands = await findTests(root, (await loadConfig(root)).tests);
  const changed = await changedFiles(root);
  return {
    command: commands.map((c) => c.label).join(", "),
    ...(openFile && index.files.includes(openFile) ? { open: { file: openFile, tests: testsFor([openFile], index).length } } : {}),
    ...(changed ? { changed: testsFor(changed, index).length } : {}),
    files: testFiles(index),
  };
}

// Where each failing test is written: its name as a string in a test file (`test("name"`,
// `it('name'`), or `def name(` for pytest. node --test names a file that failed to load by its path.
async function locate(root: string, names: string[], files: string[]): Promise<FailingTest[]> {
  const texts = await readTexts(root, files);
  return names.slice(0, SHOWN_FAILING).map((name) => {
    const path = name.replace(/\\/g, "/"); // "tests\notes.test.js" on Windows, or a full path
    const file = files.find((f) => path === f || path.endsWith(`/${f}`));
    if (file) return { name, file, line: 1 };
    const written = new RegExp(`(["'\`])${escapeRegex(name)}\\1|\\bdef ${escapeRegex(name)}\\(`);
    for (const [f, text] of texts) {
      const at = text.split("\n").findIndex((l) => written.test(l));
      if (at >= 0) return { name, file: f, line: at + 1 };
    }
    return { name };
  });
}

// "blocked" until the person allows the project's test command; "none" when nothing in the
// scope has a test, or the test runner can't be told to run only some.
export async function runFromPanel(root: string, cache: FileCache, scope: RunScope): Promise<PanelRun> {
  const config = await loadConfig(root);
  const commands = await findTests(root, config.tests);
  const name = scope.kind === "all" ? "All tests" : scope.kind === "changed" ? "Tests for changed files" : scope.name;
  const none = (label: string): PanelRun => ({ state: "none", label, seconds: 0, tail: [], scope: name });
  if (!commands.length) return none("");
  if (!(await testsAllowed(root, commands))) return { state: "blocked", label: commands.map((c) => c.label).join(", "), seconds: 0, tail: [], scope: name };
  const index = await buildIndex(root, cache);
  let run: TestCommand[] = commands;
  if (scope.kind !== "all") {
    const sources = scope.kind === "files" ? scope.files : await changedFiles(root);
    if (!sources) return none("not a git repo, so no changed files");
    const tests = testsFor(sources, index);
    if (!tests.length) return none(scope.kind === "changed" ? "no test reaches the changed files" : "no test reaches it");
    run = commands.flatMap((c) => commandFor(c, sources, tests, root, scope.kind === "changed" ? "changed files" : basename(scope.files[0]!)) ?? []);
    if (!run.length) return none(`${commands.map((c) => c.label).join(", ")} can't run only some tests: run all`);
  }
  const result = await runTests(run, config.testTimeoutSeconds * 1000);
  const failingAt = result.failing?.length ? await locate(root, result.failing, testFiles(index)) : undefined;
  return { ...result, scope: name, ...(failingAt ? { failingAt } : {}) };
}
