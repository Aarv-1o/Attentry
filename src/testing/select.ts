import { posix, relative } from "node:path";
import type { TestCommand } from "../agent/tests.ts";
import type { RepoIndex } from "../index/repo.ts";
import { resolveModule } from "../rules/crossStack/resolve.ts";

// The tests for one source file, and the command that runs only those (the panel's Run for this
// file, docs/tests-plan.md step 2). Built from the test command the person allowed. jest and
// vitest find related tests themselves; for pytest and node --test, the repo's imports say.

// A test by its name, not just its folder: tests/helpers.ts is a helper, not a test to run.
const RUNNABLE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)tests\.py$/;

// The test files that import `file`, directly or through other files.
export function testsFor(file: string, index: RepoIndex): string[] {
  const files = new Set(index.files);
  const importers = new Map<string, string[]>();
  for (const [from, usage] of index.usage) {
    for (const imp of usage.imports) {
      const to = resolveModule(from, imp.source, files);
      if (to) importers.set(to, [...(importers.get(to) ?? []), from]);
    }
  }
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) for (const from of importers.get(queue.shift()!) ?? []) if (!seen.has(from)) seen.add(from), queue.push(from);
  return [...seen].filter((f) => RUNNABLE.test(f)).sort();
}

// A path we can put on a command line as it is: no quotes, $, ;, & or the like in it.
const PLAIN = /^[\w./@+-]+$/;

// The allowed command, narrowed to the tests for `source` (`tests`: from testsFor). Undefined
// for a runner we don't know how to narrow, or nothing to run: the panel offers Run all instead.
export function commandFor(command: TestCommand, source: string, tests: string[], root: string): TestCommand | undefined {
  const here = relative(root, command.cwd).replace(/\\/g, "/");
  const local = (f: string) => (here ? posix.relative(here, f) : f);
  const fits = (paths: string[]) => paths.length > 0 && paths.every((p) => !p.startsWith("..") && PLAIN.test(p));
  const runs = command.runs;
  let line: string | undefined;
  if (/\bvitest\b/.test(runs) && fits([local(source)])) line = `npx vitest related --run ${local(source)}`;
  else if (/\bjest\b/.test(runs) && fits([local(source)])) line = `npx jest --findRelatedTests ${local(source)}`;
  else if (fits(tests.map(local))) {
    const list = tests.map(local).join(" ");
    if (/\bpytest\b/.test(runs)) line = `python -m pytest -q ${list}`;
    // node --test with its own flags (--import tsx...): kept up to --test, then these files instead of its globs.
    else if (/^node\b.*\s--test\b/.test(runs)) line = `${runs.slice(0, runs.indexOf("--test") + "--test".length)} ${list}`;
  }
  return line ? { ...command, command: line, label: `tests for ${posix.basename(source)}` } : undefined;
}
