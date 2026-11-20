import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import { detectLanguage } from "../parse/parse.ts";
import { git } from "./git.ts";

// Used only outside git repos. Inside a repo, .gitignore decides.
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".next",
  "__pycache__", ".venv", "venv", "env", ".mypy_cache", ".pytest_cache",
]);

// Repeated setup and unused helpers are normal in tests, so most checks skip them.
// Django's startapp makes each app a tests.py.
const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\.[cm]?[jt]s$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)tests\.py$/;
export const isTestFile = (path: string) => TEST_FILE.test(path);

// Code Attentry can't read yet (see src/languages/README.md to add one). Counted so a scan
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
  let files: string[];
  try {
    files = (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  } catch {
    return undefined; // not a git repo, or git isn't installed: fall back to walking
  }
  return withoutLinkedFolders(root, files);
}

// Git for Windows lists a folder link (a junction) like a folder, with every file in it: one that
// points back up the repo lists them all again, deeper each time, until paths get too long. The
// walk below never follows links, and neither does this. Each folder is looked at once.
async function withoutLinkedFolders(root: string, files: string[]): Promise<string[]> {
  const looked = new Map<string, Promise<boolean>>();
  const isLink = (dir: string) => {
    let link = looked.get(dir);
    if (!link) looked.set(dir, (link = lstat(join(root, dir)).then((s) => s.isSymbolicLink(), () => false))); // gone since git listed it: not a link
    return link;
  };
  const throughLink = async (file: string) => {
    const folders = file.split("/").slice(0, -1);
    for (let i = 1; i <= folders.length; i++) if (await isLink(folders.slice(0, i).join("/"))) return true;
    return false;
  };
  const linked = await Promise.all(files.map(throughLink));
  return files.filter((_, i) => !linked[i]);
}

async function walk(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    // A folder inside the project that this user may not open (another program's temp files,
    // a locked system folder) isn't code anyone asked to check: skip it. The project folder
    // itself unreadable is still an error.
    if (dir !== root && (error.code === "EPERM" || error.code === "EACCES")) return [];
    throw error;
  });
  for (const entry of entries) {
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

// Installed packages: skipped even in git, where .gitignore usually hides them. A new project is
// often `git init` and `npm install` before it has a .gitignore, and scanning express's code
// there buried the project's own findings under a thousand that aren't its.
const INSTALLED = /(^|\/)(node_modules|\.venv|venv|site-packages|__pycache__)\//;

// Every file in the repo (respecting .gitignore), as sorted repo-relative paths with "/" separators.
export async function listRepoFiles(root: string): Promise<string[]> {
  return ((await gitFiles(root)) ?? (await walkProject(root))).filter((f) => !AGENT_TOOLING.test(f) && !TEST_FIXTURES.test(f) && !INSTALLED.test(f)).sort();
}

// An editor or agent opened on the home folder or a whole drive: walking it would read everything
// on the machine and still not be a project. Said plainly, so the agent can tell the person.
async function walkProject(root: string): Promise<string[]> {
  const where = resolve(root);
  if (where === resolve(homedir()) || where === parse(where).root) {
    throw new Error(`${where} is ${where === parse(where).root ? "a whole drive" : "your home folder"}, not a project, so Attentry won't scan it. Open a project folder in the editor, or start the agent in one, and Attentry checks that.`);
  }
  return walk(root);
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
