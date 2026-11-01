import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { detectLanguage } from "../parse/parse.ts";

const run = promisify(execFile);

// Used only outside git repos. Inside a repo, .gitignore decides.
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".next",
  "__pycache__", ".venv", "venv", "env", ".mypy_cache", ".pytest_cache",
]);

// Repeated setup and unused helpers are normal in tests, so most checks skip them.
const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\.[cm]?[jt]s$|(^|\/)test_[^/]*\.py$|_test\.py$/;
export const isTestFile = (path: string) => TEST_FILE.test(path);

// Code Detron can't read yet (see src/languages/README.md to add one). Counted so a scan
// never looks clean just because it skipped the code.
const UNSUPPORTED_CODE = /\.(vue|svelte|java|kt|go|rs|rb|php|cs|c|cc|cpp|h|hpp|swift|dart|scala)$/i;

export function unsupportedCode(files: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = UNSUPPORTED_CODE.exec(f)?.[1]?.toLowerCase();
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return counts;
}

export function isSource(path: string): boolean {
  // Minified bundles are generated, not written by anyone.
  return detectLanguage(path) !== undefined && !/\.min\.(js|mjs|cjs)$/i.test(path);
}

async function gitFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return undefined; // not a git repo, or git isn't installed: fall back to walking
  }
}

async function walk(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...(await walk(root, full)));
    } else if (entry.isFile()) {
      found.push(relative(root, full).split(sep).join("/"));
    }
  }
  return found;
}

// Coding agents' own folders: installed skills and commands are someone else's code, often the
// same skill installed several times, never the app's.
const AGENT_TOOLING = /(^|\/)\.(agents|claude|cursor|codex|gemini|windsurf|cline|roo|kiro|github\/(prompts|agents|skills))\//;

// Test fixtures: sample code for tests, often wrong on purpose.
const TEST_FIXTURES = /(^|\/)(tests?|__tests__|spec)\/(.+\/)?(fixtures|__fixtures__)\/|(^|\/)__fixtures__\//;

// Every file in the repo (respecting .gitignore), as sorted repo-relative paths with "/" separators.
export async function listRepoFiles(root: string): Promise<string[]> {
  return ((await gitFiles(root)) ?? (await walk(root))).filter((f) => !AGENT_TOOLING.test(f) && !TEST_FIXTURES.test(f)).sort();
}

// The app a file belongs to: the deepest folder above it with a package.json or Python project file.
export function appOf(files: string[]): (file: string) => string {
  const roots = files
    .filter((f) => /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|manage\.py)$/.test(f))
    .map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : ""))
    .sort((a, b) => b.length - a.length);
  return (file) => roots.find((r) => file.startsWith(r)) ?? "";
}

// Code written by a generator (API clients, protobuf): not something to reuse or tidy by hand.
export const isGenerated = (path: string) => /\.gen\.[cm]?[jt]sx?$|(^|\/)(generated|__generated__)\/|_pb2(_grpc)?\.py$|\.pb\.[jt]s$/.test(path);
