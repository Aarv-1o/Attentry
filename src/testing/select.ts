import { posix, relative } from "node:path";
import type { TestCommand } from "../agent/tests.ts";
import type { RepoIndex } from "../index/repo.ts";
import { resolveModule } from "../rules/crossStack/resolve.ts";

// The tests for some source files, and the command that runs only those (the panel's run menu,
// docs/tests-plan.md step 2). Built from the test command the person allowed. jest and
// vitest find related tests themselves; for pytest and node --test, the repo's imports say.

// A test by its name, not just its folder: tests/helpers.ts is a helper, not a test to run.
const RUNNABLE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)tests\.py$/;

export const testFiles = (index: RepoIndex): string[] => index.files.filter((f) => RUNNABLE.test(f)).sort();

// The test files that import any of `sources`, directly or through other files.
export function testsFor(sources: string[], index: RepoIndex): string[] {
  const files = new Set(index.files);
  const importers = new Map<string, string[]>();
  for (const [from, usage] of index.usage) {
    for (const imp of usage.imports) {
      const to = resolveModule(from, imp.source, files);
      if (to) importers.set(to, [...(importers.get(to) ?? []), from]);
    }
  }
  const seen = new Set(sources);
  const queue = [...sources];
  while (queue.length) for (const from of importers.get(queue.shift()!) ?? []) if (!seen.has(from)) seen.add(from), queue.push(from);
  return [...seen].filter((f) => RUNNABLE.test(f)).sort();
}

// A path we can put on a command line as it is: no quotes, $, ;, & or the like in it.
const PLAIN = /^[\w./@+-]+$/;

// The allowed command, narrowed to the tests for `sources` (`tests`: from testsFor).
// Undefined for a runner we don't know how to narrow, or nothing to run: Run all instead.
export function commandFor(command: TestCommand, sources: string[], tests: string[], root: string, label: string): TestCommand | undefined {
  const here = relative(root, command.cwd).replace(/\\/g, "/");
  const local = (f: string) => (here ? posix.relative(here, f) : f);
  // Another app's files are left to that app's own command.
  const mine = (paths: string[]) => paths.map(local).filter((p) => !p.startsWith(".."));
  const fits = (paths: string[]) => paths.length > 0 && paths.every((p) => PLAIN.test(p));
  const runs = command.runs;
  const [sourceList, testList] = [mine(sources), mine(tests)];
  let line: string | undefined;
  if (/\bvitest\b/.test(runs) && fits(sourceList)) line = `npx vitest related --run ${sourceList.join(" ")}`;
  else if (/\bjest\b/.test(runs) && fits(sourceList)) line = `npx jest --findRelatedTests ${sourceList.join(" ")}`;
  else if (fits(testList)) {
    if (/\bpytest\b/.test(runs)) line = `python -m pytest -q ${testList.join(" ")}`;
    // node --test with its own flags (--import tsx...): kept up to --test, then these files instead of its globs.
    else if (/^node\b.*\s--test\b/.test(runs)) line = `${runs.slice(0, runs.indexOf("--test") + "--test".length)} ${testList.join(" ")}`;
  }
  return line ? { ...command, command: line, label } : undefined;
}
