import { isGenerated, isTestFile } from "../../index/files.ts";
import type { FunctionInfo } from "../../index/functions.ts";
import { isName, JSX_MARKER, LITERAL_PREFIX } from "../../index/shape.ts";
import { supportFor } from "../../languages/index.ts";
import type { Confidence } from "../confidence.ts";

export interface DuplicateGroup {
  kind: "exact" | "similar" | "cross-language";
  confidence: Confidence;
  functions: FunctionInfo[];
  sharedValues: string[]; // string values the copies have in common: the evidence
}


const MIN_TOKENS = 40; // smaller bodies are too generic to call copies...
const MIN_TOKENS_MANY_COPIES = 15; // ...unless the same small body shows up in 3+ files
const SAME_STRUCTURE = 0.8;
const DRIFTED_STRUCTURE = 0.45;
const MARKUP_HEAVY = 0.03; // icons and static pages look alike by nature
const MAX_LINES_SIMILAR = 120; // whole pages and module factories share vocabulary, not logic

// A function and a helper defined inside it naturally share code.
const nested = (a: FunctionInfo, b: FunctionInfo) =>
  a.file === b.file && ((a.startLine <= b.startLine && a.endLine >= b.endLine) || (b.startLine <= a.startLine && b.endLine >= a.endLine));
const key = (fn: FunctionInfo) => fn.shape.join("\u0001");
const family = (fn: FunctionInfo) => supportFor(fn.language).family;
const markupHeavy = (fn: FunctionInfo) => fn.shape.filter((t) => t === JSX_MARKER).length / fn.shape.length > MARKUP_HEAVY;

// Structure only: names and values blanked out, in overlapping 3-token windows. Each window is
// a number, and a function's windows a sorted array of them: comparing two functions is then a
// merge of two arrays, not thousands of string lookups (it runs for every pair, on every check).
function structure(fn: FunctionInfo, ids: Map<string, number>): Int32Array {
  const t = fn.shape.map((s) => (s.startsWith(LITERAL_PREFIX) ? "lit" : isName(s) ? "id" : s));
  const set = new Set<number>();
  for (let i = 0; i + 3 <= t.length; i++) {
    const window = `${t[i]} ${t[i + 1]} ${t[i + 2]}`;
    let id = ids.get(window);
    if (id === undefined) ids.set(window, (id = ids.size));
    set.add(id);
  }
  return Int32Array.from(set).sort();
}

function jaccard(a: Int32Array, b: Int32Array): number {
  let shared = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) (shared++, i++, j++);
    else if (a[i]! < b[j]!) i++;
    else j++;
  }
  return shared / (a.length + b.length - shared || 1);
}

// Meaningful string values, case-folded so "Just now" and "just now" match.
function values(fn: FunctionInfo): Set<string> {
  const out = new Set<string>();
  for (const t of fn.shape) {
    if (!t.startsWith(LITERAL_PREFIX)) continue;
    const v = t.slice(LITERAL_PREFIX.length).trim().toLowerCase();
    if (v.length >= 4 && !/^-?[\d.]+$/.test(v)) out.add(v);
  }
  return out;
}

// Wording ("just now", "Connection failed.") says more than codes ("send", "notify_broker"),
// which are often just a shared vocabulary of statuses or types.
const distinctive = (v: string) => /[^\w]/.test(v);

// "_strip_json_state" and "stripJsonState" both become "strip json state".
export const nameWords = (name: string) =>
  name.replace(/^_+/, "").split(/_|(?<=[a-z0-9])(?=[A-Z])/).map((w) => w.toLowerCase()).join(" ");

class Clusters {
  private parent = new Map<number, number>();
  find(i: number): number {
    const p = this.parent.get(i) ?? i;
    if (p === i) return i;
    const root = this.find(p);
    this.parent.set(i, root);
    return root;
  }
  join(a: number, b: number) { this.parent.set(this.find(a), this.find(b)); }
  groups(ids: number[]): number[][] {
    const out = new Map<number, number[]>();
    for (const i of ids) out.set(this.find(i), [...(out.get(this.find(i)) ?? []), i]);
    return [...out.values()].filter((g) => g.length > 1);
  }
}

export function findDuplicates(all: FunctionInfo[]): DuplicateGroup[] {
  // Generated code (an API client) repeats itself by design, and nobody edits it by hand.
  const fns = all.filter((f) => !isTestFile(f.file) && !isGenerated(f.file));
  const groups: DuplicateGroup[] = [];

  // 1. Exact copies: same structure, same values, only names differ.
  const byShape = new Map<string, FunctionInfo[]>();
  for (const fn of fns) if (fn.shape.length >= MIN_TOKENS_MANY_COPIES) byShape.set(key(fn), [...(byShape.get(key(fn)) ?? []), fn]);
  for (const copies of byShape.values()) {
    const files = new Set(copies.map((f) => f.file)).size;
    if (copies.length > 1 && (copies[0]!.shape.length >= MIN_TOKENS || files >= 3)) {
      // The code itself proves an exact copy; only wording is worth showing ("role" is not).
      const wording = [...values(copies[0]!)].filter(distinctive);
      groups.push({ kind: "exact", confidence: "sure", functions: copies, sharedValues: wording });
    }
  }

  // 2. Similar copies, compared one representative per exact group.
  const reps = [...byShape.values()].map((c) => c[0]!).filter(
    (f) => f.shape.length >= MIN_TOKENS && !markupHeavy(f) && f.endLine - f.startLine < MAX_LINES_SIMILAR,
  );
  const windowIds = new Map<string, number>();
  const shapes = reps.map((fn) => structure(fn, windowIds));
  const vals = reps.map(values);
  const uses = new Map<string, number>();
  for (const fn of fns) for (const v of values(fn)) uses.set(v, (uses.get(v) ?? 0) + 1);
  // A value used all over the repo ("Content-Type") proves nothing. Scaled to repo size,
  // because a value copied 10 times is exactly what we're looking for.
  const rareMaxUses = Math.max(3, Math.ceil(fns.length * 0.02));
  const likely = new Clusters();
  const maybe = new Clusters();
  const evidence = new Map<number, Set<string>>();
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      const [a, b] = [reps[i]!.shape.length, reps[j]!.shape.length];
      if (Math.min(a, b) / Math.max(a, b) < 0.6 || nested(reps[i]!, reps[j]!)) continue;
      // Jaccard is at most the smaller set over the larger: too different in size can't be close enough.
      const [x, y] = [shapes[i]!.length, shapes[j]!.length];
      if (Math.min(x, y) < DRIFTED_STRUCTURE * Math.max(x, y)) continue;
      const sim = jaccard(shapes[i]!, shapes[j]!);
      if (sim < DRIFTED_STRUCTURE) continue;
      const shared = [...vals[i]!].filter((v) => vals[j]!.has(v));
      const rare = shared.filter((v) => (uses.get(v) ?? 0) <= rareMaxUses);
      const telling = rare.filter(distinctive);
      if (telling.length >= 3 || (sim >= SAME_STRUCTURE && telling.length >= 1)) {
        likely.join(i, j); // same purpose: they share specific wording
      } else if (sim >= SAME_STRUCTURE || rare.length >= 3) {
        maybe.join(i, j); // same structure, different values: could share a helper
      } else continue;
      for (const k of [i, j]) evidence.set(k, new Set([...(evidence.get(k) ?? []), ...telling]));
    }
  }
  const ids = reps.map((_, i) => i);
  const expand = (members: number[]) => members.flatMap((i) => byShape.get(key(reps[i]!))!);
  const likelyGroups = likely.groups(ids);
  for (const members of likelyGroups) {
    groups.push({ kind: "similar", confidence: "likely", functions: expand(members), sharedValues: [...(evidence.get(members[0]!) ?? [])] });
  }
  for (const members of maybe.groups(ids)) {
    if (likelyGroups.some((g) => members.every((m) => g.includes(m)))) continue;
    groups.push({ kind: "similar", confidence: "maybe", functions: expand(members), sharedValues: [] });
  }

  // 3. The same function written in two languages (say JS and Python): same name, ideally the same values too.
  const byName = new Map<string, FunctionInfo[]>();
  for (const fn of fns) {
    const words = nameWords(fn.name);
    if (words.includes(" ") && fn.shape.length >= 20) byName.set(words, [...(byName.get(words) ?? []), fn]); // one-word names collide too often
  }
  for (const named of byName.values()) {
    const families = new Map<string, FunctionInfo[]>();
    for (const f of named) families.set(family(f), [...(families.get(family(f)) ?? []), f]);
    if (families.size < 2) continue;
    // Values found in at least two languages.
    const seenIn = new Map<string, Set<string>>();
    for (const [fam, fs] of families) for (const f of fs) for (const v of values(f)) seenIn.set(v, new Set([...(seenIn.get(v) ?? []), fam]));
    const shared = [...seenIn].filter(([, fams]) => fams.size > 1).map(([v]) => v);
    groups.push({ kind: "cross-language", confidence: shared.length >= 2 ? "likely" : "maybe", functions: [...families.values()].flat(), sharedValues: shared });
  }

  const rank = { sure: 0, likely: 1, maybe: 2 };
  return groups.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.functions.length - a.functions.length);
}
