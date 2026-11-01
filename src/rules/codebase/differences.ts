import type { FunctionInfo } from "../../index/functions.ts";
import { readTexts } from "../../index/texts.ts";
import type { DuplicateGroup } from "./duplicates.ts";

export interface SourceLine {
  line: number;
  text: string;
}

// One place where a copy departs from the base version. Either side may be missing:
// a line only the base has, or only the copy has.
export interface LineChange {
  base: SourceLine | undefined;
  copy: SourceLine | undefined;
}

export interface CopyDifferences {
  base: FunctionInfo; // the most common version
  copies: { fn: FunctionInfo; changes: LineChange[] }[];
  // When most lines differ, the functions share a setup or some wording, not their logic.
  mostlyDifferent: boolean;
}

const KEYWORDS = new Set([
  "if", "else", "return", "const", "let", "var", "function", "new", "for", "while", "do", "switch", "case",
  "break", "continue", "try", "catch", "finally", "throw", "await", "async", "typeof", "instanceof", "in", "of",
  "null", "undefined", "true", "false", "this", "def", "elif", "not", "and", "or", "is", "None", "True", "False",
  "raise", "except", "with", "as", "lambda", "pass", "yield", "from", "import", "self",
]);

// A line with every name blanked out, so "if (mins < 1)" and "if (m < 1)" match,
// but "if (s < 45)" doesn't. Strings are kept whole: their wording matters.
export function normalizeLine(text: string): string {
  return text
    .trim()
    .split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part.replaceAll("'", '"').replaceAll("`", '"').replace(/\$\{[^}]*\}/g, "${_}")
        : part.replace(/[A-Za-z_$][\w$]*/g, (w) => (KEYWORDS.has(w) ? w : "_")).replace(/\s+/g, " "),
    )
    .join("");
}

const isNoise = (text: string) => !text.trim() || /^\s*(\/\/|#|\/\*|\*)/.test(text);

// Lines that explain rather than run: a Python docstring at the top of the body, and the
// inside of a /* ... */ block. A copy that only gained a docstring hasn't drifted.
function explanationRows(lines: string[]): Set<number> {
  const rows = new Set<number>();
  let closing: string | undefined; // what ends the comment or docstring we're in
  let first = true;
  lines.forEach((text, i) => {
    const t = text.trim();
    if (closing) {
      rows.add(i);
      if (t.includes(closing)) closing = undefined;
      return;
    }
    if (!t || isNoise(text)) {
      if (t.startsWith("/*") && !t.includes("*/")) closing = "*/";
      return;
    }
    const doc = first && /^[rRuUbB]?("""|''')/.exec(t);
    first = false;
    if (doc) {
      rows.add(i);
      const rest = t.slice(doc[0].length);
      if (!rest.includes(doc[1]!)) closing = doc[1];
    }
  });
  return rows;
}

// The body only: the first line is the signature, which differs in name and style anyway.
function bodyLines(fn: FunctionInfo, source: string): SourceLine[] {
  const lines = source.split("\n").slice(fn.startLine, fn.endLine);
  const explains = explanationRows(lines);
  return lines
    .map((text, i) => ({ line: fn.startLine + 1 + i, text }))
    .filter((l, i) => !isNoise(l.text) && !explains.has(i));
}

const tokens = (text: string) => new Set(normalizeLine(text).match(/"[^"]*"|\w+|[^\s\w]+/g) ?? []);

function similarity(a: SourceLine, b: SourceLine): number {
  const x = tokens(a.text);
  const y = tokens(b.text);
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared || 1);
}

// Within a run of changed lines, pair each base line with the copy line most like it, so
// `if (mins < 1) return "Just now"` lines up with `if (s < 45) return "just now"` even when
// the copy moved things around. Unpaired lines are ones only one side has.
function pairUp(onlyBase: SourceLine[], onlyCopy: SourceLine[]): LineChange[] {
  const candidates: [number, number, number][] = [];
  onlyBase.forEach((b, i) => onlyCopy.forEach((c, j) => candidates.push([similarity(b, c), i, j])));
  const partner = new Map<number, number>();
  const taken = new Set<number>();
  for (const [score, i, j] of candidates.sort((x, y) => y[0] - x[0])) {
    if (score < 0.4) break;
    if (partner.has(i) || taken.has(j)) continue;
    partner.set(i, j);
    taken.add(j);
  }
  const changes: LineChange[] = onlyBase.map((b, i) => ({ base: b, copy: partner.has(i) ? onlyCopy[partner.get(i)!] : undefined }));
  onlyCopy.forEach((c, j) => taken.has(j) || changes.push({ base: undefined, copy: c }));
  return changes;
}

// Longest common subsequence of normalized lines; whatever is left over is a change.
function compare(base: SourceLine[], copy: SourceLine[]): LineChange[] {
  const a = base.map((l) => normalizeLine(l.text));
  const b = copy.map((l) => normalizeLine(l.text));
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const changes: LineChange[] = [];
  const onlyBase: SourceLine[] = [];
  const onlyCopy: SourceLine[] = [];
  // `headers: { "Content-Type": "application/json" }` split over three lines is the same code.
  const squash = (ls: SourceLine[]) =>
    ls.map((l) => normalizeLine(l.text)).join("").replace(/\s+/g, "").replace(/,(?=[}\])])/g, ""); // trailing commas too
  const flush = () => {
    if (squash(onlyBase) !== squash(onlyCopy)) changes.push(...pairUp(onlyBase, onlyCopy));
    onlyBase.length = 0;
    onlyCopy.length = 0;
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      onlyBase.push(base[i++]!);
    } else {
      onlyCopy.push(copy[j++]!);
    }
  }
  flush();
  return changes;
}

const key = (fn: FunctionInfo) => fn.shape.join("\u0001");

// For copies that drifted apart: what each one does differently from the most common version.
// Exact copies (only names differ) and copies in different languages aren't compared line by line.
export async function findDifferences(root: string, group: DuplicateGroup): Promise<CopyDifferences | undefined> {
  if (group.kind !== "similar") return undefined;
  const sources = await readTexts(root, [...new Set(group.functions.map((f) => f.file))]);
  const counts = new Map<string, number>();
  for (const fn of group.functions) counts.set(key(fn), (counts.get(key(fn)) ?? 0) + 1);
  const base = [...group.functions].sort((x, y) => counts.get(key(y))! - counts.get(key(x))!)[0]!;
  const baseLines = bodyLines(base, sources.get(base.file) ?? "");
  const copies = group.functions
    .filter((fn) => key(fn) !== key(base))
    .map((fn) => ({ fn, changes: compare(baseLines, bodyLines(fn, sources.get(fn.file) ?? "")) }))
    .filter((c) => c.changes.length > 0);
  if (!copies.length) return undefined;
  const mostlyDifferent = copies.every((c) => c.changes.length > baseLines.length / 2);
  return { base, copies, mostlyDifferent };
}
