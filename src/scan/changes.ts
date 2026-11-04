import { WHOLE_FILE_RULES, type Finding } from "../findings/types.ts";
import { git } from "../index/git.ts";

// "Your changes": the lines a branch (or uncommitted work) added or changed. Showing only the
// findings there keeps a big repo's old issues from burying what this change introduced
// (Snyk's "delta findings"), and keeps what an agent reads short.

export type Changes =
  | { ok: true; base: string; files: Map<string, Set<number> | "all"> }
  | { ok: false; reason: string };

async function tryGit(root: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(root, args)).trim();
  } catch {
    return undefined; // the ref doesn't exist: the caller tries the next one
  }
}

// On a feature branch: everything since it left the main branch. On the main branch: what
// isn't committed yet.
async function pickBase(root: string): Promise<string> {
  const branch = await tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remoteMain = (await tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.replace(/^origin\//, "");
  for (const main of [remoteMain, "main", "master"].filter((b): b is string => !!b)) {
    if (branch === main) return "HEAD";
    const ref = (await tryGit(root, ["rev-parse", "--verify", "--quiet", main])) ? main : (await tryGit(root, ["rev-parse", "--verify", "--quiet", `origin/${main}`])) ? `origin/${main}` : undefined;
    if (!ref) continue;
    const forkPoint = await tryGit(root, ["merge-base", "HEAD", ref]);
    if (forkPoint) return forkPoint;
  }
  return "HEAD";
}

// `git diff -U0` hunks: "@@ -12,3 +14,5 @@" means lines 14-18 are new. A deletion ("+14,0")
// marks the line where code was removed.
function addHunks(diff: string, prefix: string, files: Map<string, Set<number> | "all">): void {
  let current: Set<number> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      current = path !== "/dev/null" && path.startsWith(prefix) ? new Set() : undefined;
      if (current) files.set(path.slice(prefix.length), current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + Math.max(count, 1); n++) current.add(n);
  }
}

export async function changedLines(root: string, base?: string): Promise<Changes> {
  const prefix = await tryGit(root, ["rev-parse", "--show-prefix"]);
  if (prefix === undefined) return { ok: false, reason: "not a git repo" };
  if (!(await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))) return { ok: false, reason: "no commits yet" };
  const from = base ?? (await pickBase(root));
  if (!(await tryGit(root, ["rev-parse", "--verify", "--quiet", from]))) return { ok: false, reason: `can't find ${from} in git` };
  const files = new Map<string, Set<number> | "all">();
  addHunks(await git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", from, "--", "."]), prefix, files);
  for (const file of (await git(root, ["ls-files", "--others", "--exclude-standard", "--", "."])).split("\n").filter(Boolean)) files.set(file, "all");
  return { ok: true, base: from, files };
}

export function isInChanges(finding: Finding, changes: Changes): boolean {
  if (!changes.ok) return true; // without git, everything is "yours"
  const lines = changes.files.get(finding.file);
  if (!lines) return false;
  if (lines === "all" || WHOLE_FILE_RULES.has(finding.rule)) return true; // a whole-file finding counts when the file changed
  for (let n = finding.line; n <= (finding.endLine ?? finding.line); n++) if (lines.has(n)) return true;
  return false;
}
