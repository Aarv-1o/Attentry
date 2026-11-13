import { resolve } from "node:path";
import type { FileEdit } from "./hooks.ts";

// Codex edits files with `apply_patch`, in its own patch format: no line numbers, so it isn't a
// unified diff and diff libraries can't apply it.
//
//   *** Begin Patch
//   *** Add File: hello.js        then the file's lines, each starting with +
//   *** Update File: math.js      optionally *** Move to: other.js
//   @@ function add               a hunk; text after @@ names a line to find first
//    unchanged line               lines start with " " (kept), "-" (removed) or "+" (added)
//   *** Delete File: old.js
//   *** End Patch

export interface Hunk {
  anchor: string | undefined;
  old: string[]; // the kept and removed lines, in order: what the file has now
  new: string[]; // the kept and added lines: what it will have
  atEnd: boolean; // "*** End of File": the hunk is at the end of the file
}

type PatchFile =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo: string | undefined; hunks: Hunk[] };

const FILE = /^\*\*\* (Add|Delete|Update) File: (.+)$/;
const newHunk = (anchor?: string): Hunk => ({ anchor: anchor || undefined, old: [], new: [], atEnd: false });

function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "*** End Patch") break;
    const header = FILE.exec(line.trim());
    if (header) {
      const [, kind, path] = header as unknown as [string, string, string];
      files.push(kind === "Add" ? { kind: "add", path, lines: [] } : kind === "Delete" ? { kind: "delete", path } : { kind: "update", path, moveTo: undefined, hunks: [] });
      continue;
    }
    const file = files.at(-1);
    if (file?.kind === "add" && line.startsWith("+")) file.lines.push(line.slice(1));
    if (file?.kind !== "update") continue;
    if (line.startsWith("*** Move to: ")) file.moveTo = line.slice("*** Move to: ".length).trim();
    else if (line.trim() === "*** End of File") {
      if (file.hunks.length) file.hunks.at(-1)!.atEnd = true;
    } else if (line.startsWith("@@")) file.hunks.push(newHunk(line.slice(2).trim()));
    else {
      if (!file.hunks.length) file.hunks.push(newHunk()); // the first hunk may leave out its @@
      const hunk = file.hunks.at(-1)!;
      if (line.startsWith("+")) hunk.new.push(line.slice(1));
      else if (line.startsWith("-")) hunk.old.push(line.slice(1));
      else {
        const kept = line.startsWith(" ") ? line.slice(1) : line; // an empty line is a kept empty line
        hunk.old.push(kept);
        hunk.new.push(kept);
      }
    }
  }
  return files;
}

// Where `want` starts in `lines`, at or after `from`. Like Codex: exact lines first, then
// ignoring spaces at the end, then at both ends. -1 if it isn't there.
function seek(lines: string[], want: string[], from: number): number {
  for (const same of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]) {
    for (let i = from; i + want.length <= lines.length; i++) {
      if (want.every((w, k) => same(lines[i + k]!) === same(w))) return i;
    }
  }
  return -1;
}

// The file after the hunks, or undefined when one doesn't fit it (then Codex refuses the patch).
export function applyHunks(before: string, hunks: Hunk[]): string | undefined {
  const lines = before.split("\n");
  const end = () => (lines.at(-1) === "" ? lines.length - 1 : lines.length); // before the final newline
  let at = 0;
  for (const hunk of hunks) {
    if (hunk.anchor) {
      const i = seek(lines, [hunk.anchor], at);
      if (i < 0) return undefined;
      at = i + 1;
    }
    // A hunk with nothing to find adds its lines at the end; one marked as the end is looked for there first.
    const atEnd = !hunk.old.length ? end() : hunk.atEnd ? seek(lines, hunk.old, Math.max(at, end() - hunk.old.length)) : -1;
    const where = atEnd >= 0 ? atEnd : seek(lines, hunk.old, at);
    if (where < 0) return undefined;
    lines.splice(where, hunk.old.length, ...hunk.new);
    at = where + hunk.new.length;
  }
  return lines.join("\n");
}

// A patch as the files it changes. Its paths are relative to the folder Codex runs in.
export function patchEdits(patch: string, cwd: string): FileEdit[] {
  return parsePatch(patch).flatMap((file): FileEdit[] => {
    const path = resolve(cwd, file.path);
    if (file.kind === "add") return [{ path, write: file.lines.map((line) => `${line}\n`).join("") }];
    if (file.kind === "delete") return [{ path }];
    return [{ path, hunks: file.hunks }, ...(file.moveTo ? [{ path: resolve(cwd, file.moveTo) }] : [])];
  });
}
