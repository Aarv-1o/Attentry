import { loadConfig } from "../agent/config.ts";
import { findTests, runTests, type TestRun } from "../agent/tests.ts";
import { testsAllowed } from "../agent/trust.ts";
import type { FileCache } from "../index/fileScan.ts";
import { buildIndex } from "../index/repo.ts";
import { AUTH_GUARD, PUBLIC_PATH } from "../rules/security/endpoints.ts";
import { routeCoverage } from "./coverage.ts";
import { commandFor, testsFor } from "./select.ts";

// The panel's Tests section: routes no test reaches, worst first, the last run, and the two
// buttons (Run all, Run for this file). Runs only test commands the person allowed.

export interface TestsView {
  suggestions: boolean; // the plan check's test suggestions are on
  routes: number; // routes found
  untested: { method: string; path: string; file: string; line: number; open: boolean }[]; // open: no auth check on it
  last: (TestRun & { at: number; scope: string }) | null;
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL"]);

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

// Run all, or the tests for one file (`file`: repo-relative). "blocked" until the person allows
// the project's test command; "none" when there's no test for that file.
export async function runFromPanel(root: string, cache: FileCache, file: string | undefined): Promise<TestRun & { scope: string }> {
  const config = await loadConfig(root);
  const commands = await findTests(root, config.tests);
  const scope = file ?? "all";
  if (!commands.length) return { state: "none", label: "", seconds: 0, tail: [], scope };
  if (!(await testsAllowed(root, commands))) return { state: "blocked", label: commands.map((c) => c.label).join(", "), seconds: 0, tail: [], scope };
  if (!file) return { ...(await runTests(commands, config.testTimeoutSeconds * 1000)), scope };
  const tests = testsFor(file, await buildIndex(root, cache));
  const narrowed = commands.flatMap((c) => commandFor(c, file, tests, root) ?? []);
  if (!narrowed.length) return { state: "none", label: `no tests found for ${file}`, seconds: 0, tail: [], scope };
  return { ...(await runTests(narrowed, config.testTimeoutSeconds * 1000)), scope };
}
