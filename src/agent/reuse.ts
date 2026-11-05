import { appOf, isGenerated, isTestFile } from "../index/files.ts";
import { extractFunctions, type FunctionInfo } from "../index/functions.ts";
import type { RepoIndex } from "../index/repo.ts";
import { LITERAL_PREFIX } from "../index/shape.ts";
import { nameUses } from "../index/usage.ts";
import { parseText } from "../parse/parse.ts";
import type { Confidence } from "../rules/confidence.ts";
import { supportFor } from "../languages/index.ts";
import { FRAMEWORK_EXPORTS } from "../rules/codebase/deadFunctions.ts";
import { findDuplicates, nameWords } from "../rules/codebase/duplicates.ts";

// Before an agent writes a function: does the repo already have one that does this? Agents
// rebuild helpers under new names because they lose track of what exists (AI code has ~1.9x the
// redundancy of human code). Uses the same copy finder as `attentry scan`, so a "sure" here is an
// exact copy, nothing looser.

const family = (fn: FunctionInfo) => supportFor(fn.language).family;
const SMALL = 40; // tokens
const telling = (token: string) => token.startsWith(LITERAL_PREFIX) && /[^\d.\s]{3}/.test(token.slice(LITERAL_PREFIX.length));

export interface ExistingMatch {
  candidate: string; // the new function's name
  existing: FunctionInfo;
  confidence: Confidence; // sure: an exact copy. likely: same job, or the same name elsewhere
  why: string;
  uses: number; // how often the existing one is used
}

export type NewFunction = FunctionInfo & { inside: string[] }; // names of the functions it's written inside

// Functions in the code about to be written that aren't there now (an edit that changes an
// existing function isn't a new one). Code that doesn't parse cleanly is skipped.
export async function newFunctions(file: string, before: string, after: string): Promise<NewFunction[]> {
  const read = async (text: string) => {
    const parsed = await parseText(file, text);
    if (!parsed) return [];
    try {
      return extractFunctions(parsed, file);
    } finally {
      parsed.tree.delete();
    }
  };
  const had = new Set((await read(before)).map((f) => f.name));
  const all = await read(after);
  const inside = (f: FunctionInfo) => all.filter((o) => o !== f && o.startLine <= f.startLine && f.endLine <= o.endLine).map((o) => o.name);
  return all.filter((f) => !had.has(f.name)).map((f) => ({ ...f, inside: inside(f) }));
}

// Names that many files define on purpose: event handlers, framework hooks, conventions.
// One-word names (load, save, render) are too common to mean "the same function".
const CONVENTION = /^(handle|on)[A-Z_]|^(mapStateToProps|mapDispatchToProps|getInitialProps|setup|teardown)$/;
const meaningfulName = (name: string) => nameWords(name).split(" ").length >= 2 && !CONVENTION.test(name) && !FRAMEWORK_EXPORTS.has(name);

// `replacing`: the agent rewrites `file` whole, so what's in it now doesn't count as existing.
export function findExisting(candidates: NewFunction[], index: RepoIndex, file: string, replacing: boolean): ExistingMatch[] {
  if (isTestFile(file)) return []; // tests repeat setup on purpose
  // A helper written inside a function shares its code: never compare the two.
  const around = new Set(candidates.flatMap((c) => c.inside));
  const pool = index.functions.filter((f) => !isTestFile(f.file) && !isGenerated(f.file) && !(replacing && f.file === file) && !(f.file === file && around.has(f.name)));
  // Only what this code can import: the same app (package.json or Python project).
  const app = appOf(index.allFiles);
  const sameApp = (f: FunctionInfo) => app(f.file) === app(file);
  const uses = nameUses(index.usage, index.functions);
  const usesOf = (fn: FunctionInfo) => Math.max(0, uses.get(fn.name) ?? 0);
  // The new functions get a file of their own, so nothing mistakes them for code in the file today.
  // Callbacks in objects and class methods (onSettled, componentWillMount) are wiring in each
  // file, not something to import: only real functions on both sides.
  const fresh = candidates.filter((c) => c.kind === "function").map((c) => ({ ...c, file: `${file}\u0000new` }));
  const isNew = (f: FunctionInfo) => f.file.endsWith("\u0000new");
  const found = new Map<string, ExistingMatch>();
  for (const group of findDuplicates([...pool, ...fresh])) {
    if (group.confidence === "maybe") continue;
    // A tiny function (a style object, a one-line handler) matches others by being generic: it
    // counts only with distinctive text or a pattern in it (escapeRegex's regex, a message).
    if (group.functions.every((f) => f.shape.length < SMALL && !f.shape.some(telling))) continue;
    const old = group.functions.filter((f) => !isNew(f) && f.kind === "function" && sameApp(f)).sort((a, b) => usesOf(b) - usesOf(a))[0];
    if (!old) continue;
    const why = group.kind === "exact" ? "the same code, only the names differ"
      : group.sharedValues.length ? `the same steps and the same text (${group.sharedValues.slice(0, 3).map((v) => `"${v}"`).join(", ")})` : "the same steps";
    for (const c of group.functions.filter(isNew)) {
      if (!found.has(c.name)) found.set(c.name, { candidate: c.name, existing: old, confidence: group.kind === "exact" ? "sure" : "likely", why, uses: usesOf(old) });
    }
  }
  // The same name: only for a function written to be reused (exported, not registered with a
  // framework by a decorator), in the same language, and not a name several files share on
  // purpose (two payment providers both have createCheckout).
  for (const c of candidates) {
    if (found.has(c.name) || c.decorated || !meaningfulName(c.name)) continue;
    // deleteUser (a function) and DeleteUser (a component) are different things: the case must match.
    const same = pool.filter((f) => f.file !== file && f.kind === "function" && f.exported && !f.decorated && sameApp(f) && family(f) === family(c)
      && nameWords(f.name) === nameWords(c.name) && /^[A-Z]/.test(f.name) === /^[A-Z]/.test(c.name));
    if (same.length === 1) found.set(c.name, { candidate: c.name, existing: same[0]!, confidence: "likely", why: "the same name", uses: usesOf(same[0]!) });
  }
  // Several names shared with one other file is an interface (a second payment provider beside
  // the first), not a copy.
  const byName = [...found.values()].filter((m) => m.why === "the same name");
  for (const m of byName) if (byName.filter((o) => o.existing.file === m.existing.file).length >= 2) found.delete(m.candidate);
  return [...found.values()];
}
