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
// A route the plan adds ("Add GET /api/rides/:id"), not one it names as context ("the only read
// endpoint is GET /api/rides/:id"); and one it knows is there ("already exists", on that line or next to it).
const ADDS = /\b(add|adds|adding|new|create|creates|creating|implement|introduce)\b/i;
const KNOWN = /\balready\b|\bexist(s|ing)?\b/i;

// Each route the plan names, once: whether a line naming it adds it, and whether it knows it's there.
function plannedRoutes(plan: string) {
  const lines = plan.split("\n");
  const routes = new Map<string, { method: string; raw: string; adds: boolean; known: boolean }>();
  lines.forEach((line, i) => {
    for (const [, method, raw] of line.matchAll(ROUTE)) {
      const seen = routes.get(`${method} ${raw}`) ?? { method: method!, raw: raw!, adds: false, known: false };
      seen.adds ||= ADDS.test(line);
      seen.known ||= KNOWN.test(lines.slice(Math.max(0, i - 1), i + 2).join("\n"));
      routes.set(`${method} ${raw}`, seen);
    }
  });
  return [...routes.values()].filter((r) => r.adds && !r.known);
}

export function reviewPlan(plan: string, scan: ScanResult, findings: Finding[]): string[] {
  const { index } = scan;
  const notes: string[] = [];

  // Functions the plan will write that the repo has under another name.
  const existing = new Set(index.functions.map((f) => f.name));
  const named = new Set(plan.match(/[\w$]+/g)); // a plan that already says "reuse `formatPrice`" needs no note on it
  const proposed = new Set([...plan.matchAll(NAME)].map((m) => m[1]!).filter((name) => twoWords(name) && !existing.has(name)));
  for (const name of proposed) {
    // Only a function whose whole name is inside the planned one (timeAgo in formatTimeAgo): a
    // looser match is wrong too often to say unasked.
    const planned = new Set(nameWords(name).split(" "));
    const match = similarFunctions(nameWords(name), index).find((m) => twoWords(m.fn.name) && nameWords(m.fn.name).split(" ").every((w) => planned.has(w)));
    if (match && !named.has(match.fn.name)) notes.push(`\`${name}\`: the repo already has \`${match.fn.name}\` (${match.fn.file}:${match.fn.startLine}, used in ${plural(match.uses, "place")}). Reuse it instead of writing a new one.`);
  }

  // Files it changes that change all the time.
  // A bare name only when the repo has it: "Node.js" is no file.
  const all = new Set(index.allFiles);
  const files = new Set([...plan.matchAll(FILE)].map((m) => m[1]!.replace(/^\.\//, "")).filter((file) => file.includes("/") || all.has(file)));
  for (const hotspot of findings.filter((f) => f.rule === "hotspot" && files.has(f.file))) {
    notes.push(`${hotspot.file} is a hotspot (${hotspot.title.toLowerCase()}): change it in small steps, and test after each.`);
  }

  // Routes it adds that are already there.
  for (const { method, raw } of plannedRoutes(plan)) {
    const path = parsePath(raw);
    const route = path && scan.crossStack.allRoutes.find((r) => (r.method === method || r.method === "ALL") && reaches(path, r.path, "strict"));
    if (route) notes.push(`${method} ${path.text} already exists (${route.file}:${route.line}): extend it rather than adding another.`);
  }

  if (files.size >= BIG_PLAN) notes.push(`The plan touches ${files.size} files: do it in smaller steps, and check each one (Attentry's \`check\` tool) before the next.`);
  return notes.slice(0, MAX_NOTES);
}
