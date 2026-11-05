import type { Finding } from "../findings/types.ts";
import { nameWords } from "../rules/codebase/duplicates.ts";
import { parsePath, reaches } from "../rules/crossStack/paths.ts";
import type { ScanResult } from "../scan/scan.ts";
import { plural } from "../report/common.ts";
import { similarFunctions } from "./tools.ts";

// Before Claude starts on a plan (when it calls ExitPlanMode): what the repo already has that the
// plan should know about, read from the plan's own words: functions named in backticks, file
// paths, routes. Advice for Claude, never a block, and nothing at all when there's nothing to say.

const MAX_NOTES = 8;
const BIG_PLAN = 12; // files: past this, a plan is better done and checked in steps
// `formatDate` or `formatDate(value)`.
const NAME = /`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`/g;
const FILE = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,5})(?![\w/])/g;
const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'",)]*)/g;

// Two words or more: `id` or `data` could be anything.
const twoWords = (name: string) => nameWords(name).includes(" ");

export function reviewPlan(plan: string, scan: ScanResult, findings: Finding[]): string[] {
  const { index } = scan;
  const notes: string[] = [];

  // Functions the plan will write that the repo has under another name.
  const existing = new Set(index.functions.map((f) => f.name));
  const proposed = new Set([...plan.matchAll(NAME)].map((m) => m[1]!).filter((name) => twoWords(name) && !existing.has(name)));
  for (const name of proposed) {
    // Only a function whose whole name is inside the planned one (timeAgo in formatTimeAgo): a
    // looser match is wrong too often to say unasked.
    const planned = new Set(nameWords(name).split(" "));
    const match = similarFunctions(nameWords(name), index).find((m) => twoWords(m.fn.name) && nameWords(m.fn.name).split(" ").every((w) => planned.has(w)));
    if (match) notes.push(`\`${name}\`: the repo already has \`${match.fn.name}\` (${match.fn.file}:${match.fn.startLine}, used in ${plural(match.uses, "place")}). Reuse it instead of writing a new one.`);
  }

  // Files it changes that change all the time.
  // A bare name only when the repo has it: "Node.js" is no file.
  const all = new Set(index.allFiles);
  const files = new Set([...plan.matchAll(FILE)].map((m) => m[1]!.replace(/^\.\//, "")).filter((file) => file.includes("/") || all.has(file)));
  for (const hotspot of findings.filter((f) => f.rule === "hotspot" && files.has(f.file))) {
    notes.push(`${hotspot.file} is a hotspot (${hotspot.title.toLowerCase()}): change it in small steps, and test after each.`);
  }

  // Routes it adds that are already there.
  for (const [, method, raw] of plan.matchAll(ROUTE)) {
    const path = parsePath(raw!);
    const route = path && scan.crossStack.allRoutes.find((r) => (r.method === method || r.method === "ALL") && reaches(path, r.path, "strict"));
    if (route) notes.push(`${method} ${path.text} already exists (${route.file}:${route.line}): extend it rather than adding another.`);
  }

  if (files.size >= BIG_PLAN) notes.push(`The plan touches ${files.size} files: do it in smaller steps, and check each one (Attentry's \`check\` tool) before the next.`);
  return notes.slice(0, MAX_NOTES);
}
