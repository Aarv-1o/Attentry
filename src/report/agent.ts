import { GUIDES } from "../findings/guide.ts";
import { HIDES_FAILURES } from "../findings/severity.ts";
import type { Finding } from "../findings/types.ts";

// `attentry scan --agent`: findings as instructions an agent can follow, grouped by rule so the
// why/fix/check is said once. Things that fail at runtime come first; hotspots (warnings,
// not tasks) last.

const ORDER: Finding["category"][] = ["security", "crash", "frontend-backend", "database", "hygiene", "copies", "dead-code", "hotspot"];
const SAFETY = { safe: "safe to fix on its own", "ask-first": "ask the user first", warning: "a warning, not a task" };

const rank = (f: Finding) => ORDER.indexOf(f.category) * 10 + (f.category === "hygiene" && !HIDES_FAILURES.has(f.rule) ? 5 : 0);

function item(f: Finding): string[] {
  const span = f.endLine && f.endLine !== f.line ? `-${f.endLine}` : "";
  const hint = f.confidence === "maybe" ? " (hint)" : "";
  return [
    `- ${f.file}:${f.line}${span}: ${f.title}${hint}`,
    ...f.evidence.map((e) => `  - ${e}`),
    ...f.related.map((p) => `  - also ${p.file}:${p.line}${p.label ? ` (${p.label})` : ""}`),
  ];
}

function group(rule: string, items: Finding[]): string[] {
  const { name } = GUIDES[rule]!;
  const { why, fix, safety, verify } = items[0]!;
  return [
    `## ${name} (${items.length})`,
    "",
    `Why: ${why}`,
    `Safety: ${SAFETY[safety]}`,
    "",
    ...items.flatMap(item),
    "",
    "Fix:",
    ...fix.map((step, i) => `${i + 1}. ${step}`),
    "",
    `Check: ${verify}`,
    "",
  ];
}

export function formatAgent(root: string, findings: Finding[], showHints: boolean): string {
  const shown = findings.filter((f) => showHints || f.confidence !== "maybe");
  const hidden = findings.length - shown.length;
  const tasks = shown.filter((f) => f.category !== "hotspot");
  const head = [
    `# Attentry findings: ${root}`,
    "",
    `${tasks.length} finding${tasks.length === 1 ? "" : "s"}${hidden ? `, ${hidden} hint${hidden === 1 ? "" : "s"} left out (--all shows them)` : ""}.`,
    "",
    "How to work through them:",
    "- Fix one rule at a time, in its own commit, never mixed with feature work.",
    "- \"Safe\" fixes don't change what the code does: make them. \"Ask first\" ones may change behavior",
    "  or how code is shared: check with the user before making them.",
    "- After each fix, run the tests and the type check. If they fail, undo that fix.",
    "",
  ];
  if (!shown.length) return `${[...head, "Nothing to fix."].join("\n")}\n`;
  const rules = [...new Set(shown.map((f) => f.rule))].sort((a, b) => {
    const [fa, fb] = [shown.find((f) => f.rule === a)!, shown.find((f) => f.rule === b)!];
    return rank(fa) - rank(fb);
  });
  const body = rules.flatMap((rule) => {
    const items = shown.filter((f) => f.rule === rule).sort((a, b) => Number(a.confidence === "maybe") - Number(b.confidence === "maybe"));
    return group(rule, items);
  });
  return `${[...head, ...body].join("\n").trimEnd()}\n`;
}
