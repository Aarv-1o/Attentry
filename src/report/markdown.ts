import { basename } from "node:path";
import { GUIDES } from "../findings/guide.ts";
import { PART_NAMES, PARTS, partOf, severityOf, type Part } from "../findings/severity.ts";
import type { Finding } from "../findings/types.ts";

// `detron scan --markdown`: the report for a person to read in a Markdown preview (VS Code,
// GitHub, a PR comment). A summary table first, then each part, rule by rule: why it matters,
// every place as a link to its line, and the fix folded away until it's wanted.

export interface MarkdownOptions {
  root: string;
  showHints: boolean;
  stats?: { files: number; functions: number };
  older?: number; // with --changed: findings from before this change, left out
  linkBase?: string; // "" for links relative to the repo root; a file URI for the editor
}

const PART_NOTES: Record<Part, string> = {
  security: "Holes someone could use against the app",
  breaks: "Fails for users at runtime",
  database: "Slow or wrong as the data grows",
  cleanup: "Copied, unused and messy code",
};
const SAFETY = { safe: "Safe to fix on its own", "ask-first": "Ask first: the fix changes behavior or how code is shared", warning: "Not a task: a way to work here" };
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

// Text from code and messages, safe inside Markdown: code spans stay as they are, and everything
// else can't turn into HTML (`<script>`), emphasis (`__html`), links or table cells.
const CODE_SPAN = /(?<!`)(`+)(?!`)[^]*?(?<!`)\1(?!`)/g;
export function escapeMarkdown(text: string): string {
  const one = text.replace(/\s*\n\s*/g, " ");
  // A backtick left over (a title cut off mid-code) can't be paired: it's text too.
  const plain = (s: string) => s.replace(/[\\*_[\]<>|`]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : `\\${c}`));
  let out = "";
  let at = 0;
  for (const m of one.matchAll(CODE_SPAN)) {
    out += plain(one.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  return out + plain(one.slice(at));
}

function link(file: string, line: number, base: string, endLine?: number): string {
  const span = endLine && endLine !== line ? `-${endLine}` : "";
  const target = `${base}${file.split("/").map(encodeURIComponent).join("/")}#L${line}`;
  return `[\`${file}:${line}${span}\`](${target})`;
}

function place(f: Finding, base: string): string[] {
  const hint = f.confidence === "maybe" ? " _(hint)_" : "";
  return [
    `- ${link(f.file, f.line, base, f.endLine)}: ${escapeMarkdown(f.title)}${hint}`,
    ...(f.plain?.does ? [`  - What it does: ${escapeMarkdown(f.plain.does)}`] : []),
    ...(f.plain?.replacedBy ? [`  - ${escapeMarkdown(f.plain.replacedBy)}`] : []),
    // Indented evidence belongs to the line above it (each copy's differences).
    ...f.evidence.map((e) => `${/^\s/.test(e) ? "    " : "  "}- ${escapeMarkdown(e.trim())}`),
    ...f.related.map((p) => `  - Also ${link(p.file, p.line, base)}${p.label ? `: ${escapeMarkdown(p.label)}` : ""}`),
  ];
}

function rule(rule: string, items: Finding[], base: string): string[] {
  const { name } = GUIDES[rule] ?? { name: rule };
  const { why, fix, safety, verify } = items[0]!;
  return [
    `### ${escapeMarkdown(name)} · ${items.length}`,
    "",
    `**Why it matters:** ${escapeMarkdown(why)}  `,
    `**Safety:** ${SAFETY[safety]}`,
    "",
    ...items.flatMap((f) => place(f, base)),
    "",
    "<details>",
    "<summary>How to fix it</summary>",
    "",
    ...fix.map((step, i) => `${i + 1}. ${escapeMarkdown(step)}`),
    "",
    `**Check:** ${escapeMarkdown(verify)}`,
    "",
    "</details>",
    "",
  ];
}

// Rules in a part: the loudest first, then the ones with the most findings.
const SEVERITY_RANK = { error: 0, warning: 1, info: 2, hint: 3 };
function byRule(findings: Finding[]): [string, Finding[]][] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f]);
  const loudest = (fs: Finding[]) => Math.min(...fs.map((f) => SEVERITY_RANK[severityOf(f)]));
  return [...groups].sort(([, a], [, b]) => loudest(a) - loudest(b) || b.length - a.length);
}

export function formatMarkdown(findings: Finding[], { root, showHints, stats, older = 0, linkBase = "" }: MarkdownOptions): string {
  const shown = findings.filter((f) => showHints || f.confidence !== "maybe");
  const hidden = findings.length - shown.length;
  const hotspots = shown.filter((f) => f.category === "hotspot");
  const tasks = shown.filter((f) => f.category !== "hotspot");
  const inPart = (part: Part) => tasks.filter((f) => partOf(f) === part);

  const out = [`# Detron report: ${escapeMarkdown(basename(root) || root)}`, ""];
  const facts = [
    stats && `${plural(stats.files, "file")}, ${plural(stats.functions, "function")}`,
    plural(tasks.length, "finding"),
    hidden && `${plural(hidden, "hint")} hidden (\`--all\` shows them)`,
  ].filter(Boolean);
  out.push(`${facts.join(" · ")}`, "");
  if (older) out.push(`> Only your changes. ${plural(older, "older finding")} from before them are left out: \`detron scan --markdown\` shows everything.`, "");

  if (!tasks.length) {
    out.push("**Nothing to fix.**", "");
  } else {
    out.push("| Part | Findings | What it means |", "| --- | ---: | --- |");
    for (const part of PARTS) out.push(`| ${PART_NAMES[part]} | ${inPart(part).length} | ${PART_NOTES[part]} |`);
    out.push(
      "",
      "Fix one rule at a time, in its own commit, apart from feature work. Run the tests and the type check after each fix, and undo it if they fail.",
      "",
    );
  }
  for (const part of PARTS) {
    const mine = inPart(part);
    if (!mine.length) continue;
    out.push(`## ${PART_NAMES[part]} (${mine.length})`, "");
    for (const [name, items] of byRule(mine)) out.push(...rule(name, items, linkBase));
  }
  if (hotspots.length) {
    out.push("## Where to work carefully", "", "Complex files that change often. Make small changes here, and test after each one.", "");
    out.push(...hotspots.flatMap((f) => place(f, linkBase)), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
