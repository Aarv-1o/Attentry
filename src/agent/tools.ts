import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { Finding } from "../findings/types.ts";
import { severityOf } from "../findings/severity.ts";
import { isGenerated, isTestFile } from "../index/files.ts";
import type { FunctionInfo } from "../index/functions.ts";
import type { RepoIndex } from "../index/repo.ts";
import { LITERAL_PREFIX } from "../index/shape.ts";
import { nameUses } from "../index/usage.ts";
import { briefLine } from "../report/brief.ts";
import { explainFindings, findingsOn } from "../report/explain.ts";
import { nameWords } from "../rules/codebase/duplicates.ts";
import { changedLines, isInChanges } from "../scan/changes.ts";
import { uncheckedDoors } from "../rules/security/unchecked.ts";
import { planMessage } from "./hooks.ts";
import { keyOf, newSince, type Task } from "./ledger.ts";
import { findExisting, newFunctions } from "./reuse.ts";
import { plural } from "../report/common.ts";

// The tools an agent can call (MCP): ask before writing, check after. Hooks say these things
// unasked; tools are for when the agent wants to know, and for agents without hooks.

export interface ToolContext {
  root: string;
  index: () => Promise<RepoIndex>;
  findings: () => Promise<Finding[]>;
  task: () => Task | undefined; // the agent task running now, if hooks are connected
  reviewPlan: (plan: string) => Promise<string[]>;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

const MAX_MATCHES = 5;
const RARE_NAME = 2; // functions sharing a one-word name's word
const MAX_FINDINGS = 20;
const STOPWORDS = new Set("a an the to of for and or in on with from by into as is it this that function helper code some".split(" "));
const stem = (word: string) => word.replace(/(ing|ed|es|s)$/, "");
// "map" and "mapper", "format" and "formatted": one word plus a short ending. Not "time" and
// "timeline": a longer ending is another word.
export const sameWord = (a: string, b: string) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short === long || (short.length >= 3 && long.startsWith(short) && long.length - short.length <= 3);
};
export const words = (text: string) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w)).map(stem);
// Repo-relative, with every ./ and ../ worked out: "src/../../x" is outside, and says so ("../x").
const relativeFile = (root: string, file: string) => relative(root, resolve(root, file)).replace(/\\/g, "/");
const LANGUAGE_FILE: Record<string, string> = { js: "new.js", javascript: "new.js", ts: "new.ts", typescript: "new.ts", tsx: "new.tsx", jsx: "new.jsx", py: "new.py", python: "new.py" };

function describe(fn: FunctionInfo, uses: number): string {
  const where = `${fn.file}:${fn.startLine}`;
  const how = fn.exported ? "exported: import it" : "not exported: move it to a shared file to use it elsewhere";
  return `- \`${fn.name}(${fn.params.join(", ")})\` in ${where}, used in ${plural(uses, "place")} (${how})`;
}

// "format a date": functions whose name, or whose text ("just now"), says so. Best first.
export function similarFunctions(query: string, index: RepoIndex): { fn: FunctionInfo; uses: number }[] {
  const wanted = [...new Set(words(query))];
  if (!wanted.length) return [];
  const uses = nameUses(index.usage, index.functions);
  // Components (DeleteDialog) only when a component is asked for: a "send email" helper isn't EmailCard.
  const wantsComponent = /\b(component|view|page|card|button|dialog|modal|form|screen)\b/i.test(query);
  const pool = index.functions.filter((f) => !isTestFile(f.file) && !isGenerated(f.file) && f.kind === "function" && (wantsComponent || !/^[A-Z]/.test(f.name)));
  // How many functions have each word in their name: a one-word name made of a common word
  // (send, time, tokens) says little on its own.
  const named = new Map<string, number>();
  for (const f of pool) for (const w of new Set(words(nameWords(f.name)))) named.set(w, (named.get(w) ?? 0) + 1);
  const scored = pool
    .map((fn) => {
      const name = words(nameWords(fn.name));
      const text = fn.shape.filter((t) => t.startsWith(LITERAL_PREFIX)).flatMap((t) => words(t.slice(LITERAL_PREFIX.length)));
      const inName = name.filter((n) => wanted.some((w) => sameWord(n, w))).length;
      // A word in its text too (ago() returns "5m ago") is more evidence, even if its name has it.
      const inText = wanted.filter((w) => text.some((t) => sameWord(t, w))).length;
      // How much of its name the question explains: timeAgo all of it, useSceneTime a third.
      const coverage = name.length ? inName / name.length : 0;
      const rareName = name.length > 1 || (named.get(name[0] ?? "") ?? 0) <= RARE_NAME;
      return { fn, coverage, rareName, matched: inName + inText, uses: Math.max(0, uses.get(fn.name) ?? 0) };
    })
    // Its whole name is in the question (a one-word name only if few share it), or half of it
    // and two words match somewhere.
    .filter((m) => (m.coverage === 1 && (m.rareName || m.matched >= 2)) || (m.coverage >= 0.5 && m.matched >= Math.min(2, wanted.length)))
    .sort((a, b) => b.coverage - a.coverage || b.matched - a.matched || Number(b.fn.exported) - Number(a.fn.exported) || b.uses - a.uses)
    .slice(0, MAX_MATCHES);
  return scored;
}

function searchByWords(query: string, index: RepoIndex): string {
  if (!words(query).length) return "Say what the function should do, like \"format a date as time ago\".";
  const scored = similarFunctions(query, index);
  if (!scored.length) return `Nothing in the repo looks like "${query}". Write it, in a shared place if more than one file will need it.`;
  return [`Functions that may already do "${query}" (read them before writing a new one):`, ...scored.map((m) => describe(m.fn, m.uses))].join("\n");
}

// The code the agent is about to write, checked the way the hook checks it.
async function searchByCode(code: string, file: string | undefined, language: string | undefined, root: string, index: RepoIndex): Promise<ToolResult> {
  const target = file ? relativeFile(root, file) : LANGUAGE_FILE[(language ?? "").toLowerCase()];
  if (!target || !extname(target)) return { text: "Give `file` (where the code will go) or `language` (js, ts, py), so the code can be read.", isError: true };
  // Only files in the project: an agent's path must not make Attentry read ~/.ssh or /etc.
  if (target === ".." || target.startsWith("../") || isAbsolute(target)) return { text: `${file} is outside the project (${root}).`, isError: true };
  const before = file ? await readFile(resolve(root, target), "utf8").catch(() => "") : "";
  const candidates = await newFunctions(target, before, `${before}\n${code}\n`);
  if (!candidates.length) return { text: "No new function in that code (or it doesn't parse): nothing to compare." };
  const matches = findExisting(candidates, index, target, false);
  if (!matches.length) return { text: `No existing function does what ${candidates.map((c) => `\`${c.name}\``).join(", ")} does${candidates.length === 1 ? "" : " do"}. Go ahead.` };
  return {
    text: [
      "The repo already has:",
      ...matches.map((m) => `- \`${m.candidate}\`: \`${m.existing.name}\` in ${m.existing.file}:${m.existing.startLine} (used in ${plural(m.uses, "place")}) has ${m.why}. ${m.existing.exported ? "Import it." : "Move it to a shared file and use it from both places."}`),
      "Reuse it instead of adding a copy.",
    ].join("\n"),
  };
}

// Arguments come from an agent: anything that isn't the expected type counts as not given.
type Args = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);

export async function findExistingTool(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const [query, code] = [text(args.query), text(args.code)];
  if (!query && !code) return { text: "Give `query` (what the function should do) or `code` (the function you're about to write).", isError: true };
  const index = await ctx.index();
  if (code) return searchByCode(code, text(args.file), text(args.language), ctx.root, index);
  return { text: searchByWords(query!, index) };
}

// The files an agent named that Attentry reads, and a line for each of the others saying why
// not: findings filtered by a path it never read would make "no problems" a lie.
function sortFiles(files: string[], root: string, sources: string[]): { read: Set<string>; skipped: string[] } {
  const readable = new Set(sources);
  const read = new Set<string>();
  const outside: string[] = [], missing: string[] = [], unread: string[] = [];
  for (const file of new Set(files)) {
    const path = relativeFile(root, file);
    if (path === ".." || path.startsWith("../") || isAbsolute(path)) outside.push(file);
    else if (readable.has(path)) read.add(path);
    else if (!existsSync(resolve(root, path))) missing.push(path);
    else unread.push(path);
  }
  const name = basename(root);
  return {
    read,
    skipped: [
      ...(outside.length ? [`Not checked, outside ${name} (the project Attentry reads): ${outside.join(", ")}. To check them, open their folder in the editor.`] : []),
      ...(missing.length ? [`Not checked, not found in ${name}: ${missing.join(", ")}.`] : []),
      ...(unread.length ? [`Not checked, not code Attentry reads (a language it doesn't read, generated, or ignored): ${unread.join(", ")}.`] : []),
    ],
  };
}

// Problems in the given files, or in the current changes. Hints left out; what this task
// added is marked, so the agent knows what's its own to fix.
export async function checkTool(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === "string") : [];
  const all = (await ctx.findings()).filter((f) => severityOf(f) !== "hint");
  let shown: Finding[];
  let scope: string;
  let skipped: string[] = [];
  if (files.length) {
    const sorted = sortFiles(files, ctx.root, (await ctx.index()).files);
    skipped = sorted.skipped;
    // Nothing it read: no "no problems", only why each wasn't read.
    if (!sorted.read.size) return { text: [`Attentry didn't check any of these files.`, ...skipped].join("\n") };
    shown = all.filter((f) => sorted.read.has(f.file));
    scope = `${plural(sorted.read.size, "file")} in ${basename(ctx.root)}`;
  } else {
    const changes = await changedLines(ctx.root);
    shown = changes.ok ? all.filter((f) => isInChanges(f, changes)) : all;
    scope = changes.ok ? `your changes in ${basename(ctx.root)}` : `all of ${ctx.root} (can't tell what changed: ${changes.reason})`;
  }
  const task = ctx.task();
  const added = new Set(task ? newSince(task, all).map(keyOf) : []);
  // What the security checks can't see, so "no problems" isn't read as "checked and safe".
  const doors = uncheckedDoors((await ctx.index()).usage);
  const blind = doors.length ? [`Not checked for security yet: ${doors.map((d) => `${d.label} (${d.files.slice(0, 3).join(", ")})`).join("; ")}. Check who may call them (login, whose data) yourself.`] : [];
  if (!shown.length) return { text: [`No problems in ${scope}.`, ...skipped, ...blind].join("\n") };
  const loud = shown.filter((f) => severityOf(f) !== "info");
  const cleanup = shown.filter((f) => severityOf(f) === "info");
  // The other copy or the caller is what the agent needs to act on, and it can't open a report.
  const line = (f: Finding) => {
    const other = f.related[0];
    return `${briefLine(f)}${other ? ` (${other.label ?? "see"} at ${other.file}:${other.line})` : ""}${added.has(keyOf(f)) ? " (new in this task)" : ""}`;
  };
  const section = (heading: string, items: Finding[]) => {
    const listed = items.slice(0, MAX_FINDINGS);
    return items.length ? [heading, ...listed.map(line), ...(items.length > listed.length ? [`…and ${items.length - listed.length} more.`] : [])] : [];
  };
  return {
    text: [
      `${plural(loud.length, "problem")} and ${plural(cleanup.length, "clean-up item")} in ${scope}.`,
      ...section("Problems:", loud),
      ...section("Clean-up (unused or copied code: do it in its own step, apart from the feature):", cleanup),
      ...skipped,
      ...blind,
      "Full steps for one: the explain tool with its file:line.",
    ].join("\n"),
  };
}

export async function explainTool(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const m = /^(.+):(\d+)$/.exec(text(args.location)?.trim() ?? "");
  if (!m) return { text: "Give `location` as file:line, like src/app.ts:42.", isError: true };
  const file = relativeFile(ctx.root, m[1]!);
  const all = await ctx.findings();
  const here = findingsOn(all, file, Number(m[2]));
  if (here.length) return { text: explainFindings(ctx.root, here) };
  // Lines move while an agent edits: point it at the ones that do have findings.
  const lines = [...new Set(all.filter((f) => f.file === file && severityOf(f) !== "hint").map((f) => f.line))].sort((a, b) => a - b);
  return { text: `No findings on ${file}:${m[2]}.${lines.length ? ` Findings in ${file} are on line ${lines.slice(0, 10).join(", ")}.` : ""}` };
}

// A plan, before building it: the same notes the plan hook gives, for when Claude (or the person,
// with /attentry:plan) asks.
export async function checkPlanTool(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const plan = text(args.plan);
  if (!plan) return { text: "Give `plan`: the plan's full text.", isError: true };
  const notes = await ctx.reviewPlan(plan);
  return { text: notes.length ? planMessage(notes) : "Nothing in the plan clashes with what the repo has: go ahead." };
}

export const TOOLS = {
  find_existing: findExistingTool,
  check: checkTool,
  explain: explainTool,
  check_plan: checkPlanTool,
} as const;
export type ToolName = keyof typeof TOOLS;
export const isToolName = (name: string): name is ToolName => name in TOOLS;
