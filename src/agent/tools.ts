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
import { keyOf, newSince, type Task } from "./ledger.ts";
import { findExisting, newFunctions } from "./reuse.ts";

// The tools an agent can call (MCP): ask before writing, check after. Hooks say these things
// unasked; tools are for when the agent wants to know, and for agents without hooks.

export interface ToolContext {
  root: string;
  index: () => Promise<RepoIndex>;
  findings: () => Promise<Finding[]>;
  task: () => Task | undefined; // the agent task running now, if hooks are connected
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

const MAX_MATCHES = 5;
const MAX_FINDINGS = 20;
const STOPWORDS = new Set("a an the to of for and or in on with from by into as is it this that function helper code some".split(" "));
const stem = (word: string) => word.replace(/(ing|ed|es|s)$/, "");
// "map" and "mapper", "format" and "formatted": one word starting the other, both 3+ letters.
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));
const words = (text: string) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w)).map(stem);
const relativeFile = (root: string, file: string) => (isAbsolute(file) ? relative(root, file) : file).replace(/\\/g, "/").replace(/^\.\//, "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const LANGUAGE_FILE: Record<string, string> = { js: "new.js", javascript: "new.js", ts: "new.ts", typescript: "new.ts", tsx: "new.tsx", jsx: "new.jsx", py: "new.py", python: "new.py" };

function describe(fn: FunctionInfo, uses: number): string {
  const where = `${fn.file}:${fn.startLine}`;
  const how = fn.exported ? "exported: import it" : "not exported: move it to a shared file to use it elsewhere";
  return `- \`${fn.name}(${fn.params.join(", ")})\` in ${where}, used in ${plural(uses, "place")} (${how})`;
}

// "format a date": functions whose name, or whose text ("just now"), says so.
function searchByWords(query: string, index: RepoIndex): string {
  const wanted = [...new Set(words(query))];
  if (!wanted.length) return "Say what the function should do, like \"format a date as time ago\".";
  const uses = nameUses(index.usage, index.functions);
  const scored = index.functions
    .filter((f) => !isTestFile(f.file) && !isGenerated(f.file) && f.kind === "function")
    .map((fn) => {
      const name = words(nameWords(fn.name));
      const text = fn.shape.filter((t) => t.startsWith(LITERAL_PREFIX)).flatMap((t) => words(t.slice(LITERAL_PREFIX.length)));
      const score = wanted.reduce((sum, w) => sum + (name.some((n) => sameWord(n, w)) ? 2 : text.some((t) => sameWord(t, w)) ? 1 : 0), 0);
      return { fn, score, uses: Math.max(0, uses.get(fn.name) ?? 0) };
    })
    // At least one word in the name, or most of the words somewhere: one shared word in the text is chance.
    .filter((m) => m.score >= 2 && m.score >= wanted.length)
    .sort((a, b) => b.score - a.score || Number(b.fn.exported) - Number(a.fn.exported) || b.uses - a.uses)
    .slice(0, MAX_MATCHES);
  if (!scored.length) return `Nothing in the repo looks like "${query}". Write it, in a shared place if more than one file will need it.`;
  return [`Functions that may already do "${query}" (read them before writing a new one):`, ...scored.map((m) => describe(m.fn, m.uses))].join("\n");
}

// The code the agent is about to write, checked the way the hook checks it.
async function searchByCode(code: string, file: string | undefined, language: string | undefined, root: string, index: RepoIndex): Promise<ToolResult> {
  const target = file ? relativeFile(root, file) : LANGUAGE_FILE[(language ?? "").toLowerCase()];
  if (!target || !extname(target)) return { text: "Give `file` (where the code will go) or `language` (js, ts, py), so the code can be read.", isError: true };
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

// Problems in the given files, or in the current changes. Hints left out; what this task
// added is marked, so the agent knows what's its own to fix.
export async function checkTool(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === "string") : [];
  const all = (await ctx.findings()).filter((f) => severityOf(f) !== "hint");
  let shown: Finding[];
  let scope: string;
  if (files.length) {
    const wanted = new Set(files.map((f) => relativeFile(ctx.root, f)));
    shown = all.filter((f) => wanted.has(f.file));
    scope = `${plural(wanted.size, "file")} in ${basename(ctx.root)}`;
  } else {
    const changes = await changedLines(ctx.root);
    shown = changes.ok ? all.filter((f) => isInChanges(f, changes)) : all;
    scope = changes.ok ? `your changes in ${basename(ctx.root)}` : `all of ${ctx.root} (can't tell what changed: ${changes.reason})`;
  }
  const task = ctx.task();
  const added = new Set(task ? newSince(task, all).map(keyOf) : []);
  if (!shown.length) return { text: `No problems in ${scope}.` };
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
      "Full steps for one: the explain tool with its file:line.",
    ].join("\n"),
  };
}

export async function explainTool(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const m = /^(.+):(\d+)$/.exec(text(args.location)?.trim() ?? "");
  if (!m) return { text: "Give `location` as file:line, like src/app.ts:42.", isError: true };
  const file = relativeFile(ctx.root, m[1]!);
  const here = findingsOn(await ctx.findings(), file, Number(m[2]));
  return { text: here.length ? explainFindings(ctx.root, here) : `No findings on ${file}:${m[2]}.` };
}

export const TOOLS = {
  find_existing: findExistingTool,
  check: checkTool,
  explain: explainTool,
} as const;
export type ToolName = keyof typeof TOOLS;
export const isToolName = (name: string): name is ToolName => name in TOOLS;
