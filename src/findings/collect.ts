import type { FunctionInfo } from "../index/functions.ts";
import { escapeRegex, readTexts } from "../index/texts.ts";
import { nameUses } from "../index/usage.ts";
import type { DuplicateGroup } from "../rules/codebase/duplicates.ts";
import { takes } from "../rules/crossStack/check.ts";
import { worthFlagging } from "../rules/codebase/hotspots.ts";
import type { LineChange } from "../rules/codebase/differences.ts";
import type { LineFinding } from "../rules/line/types.ts";
import { hideSecrets } from "../rules/security/secrets.ts";
import type { ScanResult } from "../scan/scan.ts";
import { GUIDES } from "./guide.ts";
import { applyFeedback } from "./feedback.ts";
import { applyIgnores } from "./ignores.ts";
import { describe, likelyReplacement, type Candidate } from "./plain.ts";
import { WHOLE_FILE_RULES, type Finding, type Place } from "./types.ts";

// Every check's results as Findings, with the evidence an agent needs: the parameter names,
// every caller, every copy and how it differs.

const MAX_CALLERS = 20;

type Specific = Omit<Finding, "id" | "rule" | "category" | "why" | "fix" | "safety" | "verify" | "related" | "evidence">
  & Partial<Pick<Finding, "related" | "evidence">>;

function make(rule: string, f: Specific): Finding {
  const { category, why, fix, safety, verify } = GUIDES[rule]!;
  return { id: `${rule}:${f.file}:${f.line}`, rule, category, why, fix, safety, verify, evidence: [], related: [], ...f };
}

// Calls of a function by name, outside its own definition: `name(` or `.name(`.
function callersOf(fn: FunctionInfo, texts: Map<string, string>): Place[] {
  const call = new RegExp(`(?<![\\w$])${escapeRegex(fn.name)}\\s*\\(`);
  const found: Place[] = [];
  for (const [file, text] of texts) {
    for (const [i, line] of text.split("\n").entries()) {
      const own = file === fn.file && i + 1 >= fn.startLine && i + 1 <= fn.endLine;
      if (!own && call.test(line)) found.push({ file, line: i + 1, label: "caller" });
      if (found.length >= MAX_CALLERS) return found;
    }
  }
  return found;
}

const short = (text: string) => {
  const shown = hideSecrets(text.trim());
  return shown.length > 90 ? `${shown.slice(0, 89)}…` : shown;
};

// A line of code as a Markdown code span. Code with backticks in it (a docstring that quotes
// `fromisoformat`) needs a longer fence, or the span ends early.
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function changeText(c: LineChange): string {
  if (c.base && c.copy) return `line ${c.copy.line}: ${codeSpan(short(c.copy.text))} instead of ${codeSpan(short(c.base.text))}`;
  if (c.copy) return `line ${c.copy.line}: ${codeSpan(short(c.copy.text))} (only in this copy)`;
  return `missing ${codeSpan(short(c.base!.text))}`;
}

function copyFindings(r: ScanResult): Finding[] {
  return r.groups.map((group: DuplicateGroup) => {
    const rule = group.confidence === "maybe" ? "similar-hint"
      : group.kind === "exact" ? "exact-copy" : group.kind === "cross-language" ? "cross-language-copy" : "similar-copy";
    const [first, ...rest] = group.functions;
    const diff = r.differences.get(group);
    const evidence = [
      ...(group.sharedValues.length ? [`Same wording: ${group.sharedValues.map((v) => `"${hideSecrets(v)}"`).join(", ")}`] : []),
      ...(group.kind === "exact" ? ["Identical apart from names."] : []),
      ...(diff?.copies.flatMap(({ fn, changes }) => [`${fn.file}:${fn.startLine} ${fn.name} differs from ${diff.base.file}:${diff.base.startLine}:`, ...changes.map((c) => `  ${changeText(c)}`)]) ?? []),
    ];
    return make(rule, {
      confidence: group.confidence, file: first!.file, line: first!.startLine, endLine: first!.endLine,
      title: `${group.functions.length} copies of ${[...new Set(group.functions.map((f) => f.name))].join(" / ")}`,
      evidence,
      related: rest.map((fn) => ({ file: fn.file, line: fn.startLine, label: `copy: ${fn.name}` })),
    });
  });
}

function deadCodeFindings(r: ScanResult): Finding[] {
  const mb = (bytes: number | undefined) => (bytes ? `, ${(bytes / 1e6).toFixed(1)} MB` : "");
  return [
    ...r.dead.packages.map((p) => make("unused-package", {
      confidence: p.confidence, file: p.manifest, line: 1, title: `Unused package: ${p.name}${p.dev ? " (dev)" : ""}${mb(p.sizeBytes)}`,
      evidence: [`Nothing imports it, configures it or runs it from a script.`, `To remove: npm uninstall ${p.name}`],
    })),
    ...r.dead.files.map((f) => make("unused-file", {
      confidence: f.confidence, file: f.file, line: 1, endLine: f.lines, title: `Unused file (${f.lines} lines)`, evidence: [f.reason],
    })),
    ...r.dead.functions.filter((d) => !r.deadFiles.has(d.fn.file)).map((d) => make("dead-function", {
      confidence: d.confidence, file: d.fn.file, line: d.fn.startLine, endLine: d.fn.endLine, title: `Dead function: ${d.fn.name}`, evidence: [d.reason],
    })),
  ];
}

function crossStackFindings(r: ScanResult): Finding[] {
  const at = (p: { file: string; line: number }) => `${p.file}:${p.line}`;
  return [
    ...r.crossStack.missing.map((m) => make(m.kind, {
      confidence: m.confidence, file: m.file, line: m.line,
      title: m.kind === "missing-route" ? `Call to a route that doesn't exist: ${m.method ?? "?"} ${m.path.text}` : `Call with the wrong method: ${m.method} ${m.path.text}`,
      evidence: m.closest
        ? [m.kind === "missing-route" ? `Closest route: ${m.closest.method} ${m.closest.path.text} at ${at(m.closest)}` : `${takes(m)}, at ${at(m.closest)}`]
        : ["No route in this repo has this path."],
      related: m.closest ? [{ file: m.closest.file, line: m.closest.line, label: "route" }] : [],
    })),
    ...r.crossStack.unused.map((u) => make("unused-route", {
      confidence: u.confidence, file: u.route.file, line: u.route.line, title: `Route nothing calls: ${u.route.method} ${u.route.path.text}`,
      evidence: [`None of the ${r.crossStack.calls} API calls in this repo reach it.`],
    })),
  ];
}

function hygieneFindings(r: ScanResult, texts: Map<string, string>): Finding[] {
  const fnAt = new Map(r.index.functions.map((fn) => [`${fn.file}:${fn.startLine}`, fn]));
  return [...r.security, ...r.crashes, ...r.database, ...r.hygiene].map((h: LineFinding) => {
    const fn = fnAt.get(`${h.file}:${h.line}`);
    // The first sentence is the fact; the rest is advice the rule's guide already gives.
    const title = h.message.split(/(?<=\.) /)[0]!;
    const evidence: string[] = [];
    let related: Place[] = [];
    if (fn && (h.rule === "long-params" || h.rule === "unused-param")) {
      related = callersOf(fn, texts);
      evidence.push(related.length ? `Called from ${related.length}${related.length >= MAX_CALLERS ? "+" : ""} place(s), listed here (found by name).` : "No calls found by name.");
    }
    if (fn && h.rule === "deep-nesting") evidence.push(`Lines ${fn.startLine}-${fn.endLine}.`);
    return make(h.rule, {
      confidence: h.confidence, file: h.file, line: h.line, ...(fn ? { endLine: fn.endLine } : {}),
      title: title!.replace(/\.$/, ""), evidence, related,
    });
  });
}

function hotspotFindings(r: ScanResult, findingsIn: (file: string) => number): Finding[] {
  return r.hotspots.filter((h) => worthFlagging(h, findingsIn(h.file) > 0)).map((h) => {
    const deepest = r.index.functions.filter((fn) => fn.file === h.file).sort((a, b) => b.nesting - a.nesting)[0];
    const found = findingsIn(h.file);
    return make("hotspot", {
      confidence: "likely", file: h.file, line: deepest && deepest.nesting >= 3 ? deepest.startLine : 1,
      title: `Changed in ${h.changes} of ${r.history.ok ? r.history.commits : "?"} commits; ${h.lines} lines of code`,
      evidence: [
        ...(deepest && deepest.nesting >= 3 ? [`Most nested: ${deepest.name} (lines ${deepest.startLine}-${deepest.endLine}), ${deepest.nesting} levels.`] : []),
        ...(found ? [`${found} other finding(s) in this file: fix those when you're in here.`] : []),
      ],
    });
  });
}

// Each finding gets the code it's about in plain words: the innermost function around its line.
function addPlain(findings: Finding[], r: ScanResult): void {
  const byFile = new Map<string, typeof r.facts>();
  for (const f of r.facts) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const uses = nameUses(r.index.usage, r.facts);
  const deadAt = new Set(r.dead.functions.map((d) => `${d.fn.file}:${d.fn.startLine}`));
  const candidates: Candidate[] = r.facts.filter((f) => f.name && !deadAt.has(`${f.file}:${f.startLine}`)).map((facts) => ({ facts, uses: Math.max(0, uses.get(facts.name!) ?? 0) }));
  for (const finding of findings) {
    if (WHOLE_FILE_RULES.has(finding.rule)) continue; // no one function to explain
    const around = (byFile.get(finding.file) ?? []).filter((f) => f.startLine <= finding.line && finding.line <= f.endLine)
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
    if (!around) continue;
    const does = describe(around);
    const replacedBy = finding.rule === "dead-function" ? likelyReplacement(around, candidates) : undefined;
    if (does || replacedBy) finding.plain = { ...(does ? { does } : {}), ...(replacedBy ? { replacedBy } : {}) };
  }
}

export async function collectFindings(r: ScanResult): Promise<Finding[]> {
  const texts = await readTexts(r.root, r.index.files);
  const all = applyIgnores([...copyFindings(r), ...deadCodeFindings(r), ...crossStackFindings(r), ...hygieneFindings(r, texts)], texts);
  const findings = await applyFeedback(r.root, all);
  addPlain(findings, r);
  const findingsIn = (file: string) => findings.filter((f) => f.file === file && f.confidence !== "maybe").length;
  return [...findings, ...hotspotFindings(r, findingsIn)];
}
