import {
  CodeActionKind, DiagnosticSeverity, DiagnosticTag,
  type CodeAction, type CodeLens, type Diagnostic, type MarkupContent, type Range,
} from "vscode-languageserver";
import { GUIDES } from "../findings/guide.ts";
import { severityOf, type Severity } from "../findings/severity.ts";
import type { Finding } from "../findings/types.ts";

// Findings in the editor's terms: squiggles (diagnostics), the hover card, quick fixes and the
// hotspot banner. Pure functions, so they're tested without an editor.

const SEVERITY: Record<Severity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning, info: DiagnosticSeverity.Information, hint: DiagnosticSeverity.Hint,
};
// Code that does nothing: editors fade it, the way they fade unused variables.
const UNUSED = new Set(["dead-function", "unused-file", "unused-param"]);
const SEES = { error: "your agent sees this as an error", warning: "your agent sees this as a warning", info: "only you see this", hint: "a hint: only you see this" };
export const MAX_PER_FILE = 20;

// A file's URI, built on the folder's URI exactly as the editor sent it: VS Code on Windows
// writes file:///d%3A/..., and a URI spelled differently can count as another file.
export const uriOf = (rootUri: string, file: string) => `${rootUri.replace(/\/$/, "")}/${file.split("/").map(encodeURIComponent).join("/")}`;

// The whole line, without its indentation.
function lineRange(lines: string[], line: number, endLine = line): Range {
  const first = lines[line - 1] ?? "";
  const last = lines[endLine - 1] ?? "";
  return { start: { line: line - 1, character: first.length - first.trimStart().length }, end: { line: endLine - 1, character: last.length } };
}

export function toDiagnostic(rootUri: string, f: Finding, lines: string[]): Diagnostic {
  const unused = UNUSED.has(f.rule);
  return {
    range: lineRange(lines, f.line, unused && f.rule !== "unused-file" ? f.endLine : f.line),
    severity: SEVERITY[severityOf(f)],
    source: "Attentry",
    code: f.rule,
    // Agents read this line: the one-line fact, nothing else, to keep it cheap.
    message: f.title,
    ...(unused ? { tags: [DiagnosticTag.Unnecessary] } : {}),
    ...(f.related.length ? { relatedInformation: f.related.slice(0, 5).map((p) => ({ location: { uri: uriOf(rootUri, p.file), range: lineRange([], p.line) }, message: p.label ?? "related" })) } : {}),
    data: { id: f.id },
  };
}

// Every file's diagnostics, worst first and capped, so a messy file can't flood the editor
// (or an agent's context: Cursor passes every diagnostic it gets).
export function diagnosticsByFile(rootUri: string, findings: Finding[], linesOf: (file: string) => string[]): Map<string, Diagnostic[]> {
  const byFile = new Map<string, Diagnostic[]>();
  for (const f of findings) {
    if (f.rule === "hotspot") continue; // a banner, not a squiggle
    byFile.set(f.file, [...(byFile.get(f.file) ?? []), toDiagnostic(rootUri, f, linesOf(f.file))]);
  }
  for (const [file, list] of byFile) byFile.set(file, list.sort((a, b) => a.severity! - b.severity!).slice(0, MAX_PER_FILE));
  return byFile;
}

// The card: what the code does, what can go wrong, then how to fix and check it.
export function hoverCard(findings: Finding[]): MarkupContent {
  const cards = findings.map((f) => {
    const severity = severityOf(f);
    return [
      `**Attentry** · \`${f.rule}\` · ${f.confidence} · ${SEES[severity]}`,
      ...(f.plain?.does ? [f.plain.does] : []),
      ...(f.plain?.replacedBy ? [f.plain.replacedBy] : []),
      `**${f.title}.** ${f.why}`,
      ...(f.evidence.length ? [`Facts: ${f.evidence.join(" ")}`] : []),
      `Fix (${f.safety === "safe" ? "safe to do on its own" : f.safety === "ask-first" ? "changes behavior: check with the person first" : "not a task"}):\n${f.fix.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      `Check: ${f.verify}`,
    ].join("\n\n");
  });
  return { kind: "markdown", value: cards.join("\n\n---\n\n") };
}

const commentFor = (file: string) => (/\.py$/.test(file) ? "#" : "//");

export interface ActionOptions {
  clientCommands: boolean; // the Attentry extension is there to copy text (other editors: no clipboard command)
  explain: (f: Finding) => string; // the full text for the agent
}

export function codeActions(uri: string, findings: Finding[], lines: string[], { clientCommands, explain }: ActionOptions): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const f of findings) {
    // Only structure-only fixes are automatic: deleting code nothing uses.
    if (f.rule === "dead-function" && f.safety === "safe" && f.confidence === "sure" && f.endLine) {
      // Take one blank line after it too, but not the empty "line" after the file's last newline.
      const blankAfter = f.endLine + 1 < lines.length && lines[f.endLine]!.trim() === "" ? 1 : 0;
      actions.push({
        title: `Delete ${f.title.replace(/^Dead function: /, "")} (nothing uses it)`, kind: CodeActionKind.QuickFix, isPreferred: true,
        edit: { changes: { [uri]: [{ range: { start: { line: f.line - 1, character: 0 }, end: { line: f.endLine + blankAfter, character: 0 } }, newText: "" }] } },
      });
    }
    if (clientCommands) {
      actions.push({ title: `Attentry: copy the fix for your agent (${f.rule})`, kind: CodeActionKind.QuickFix, command: { title: "Copy fix for agent", command: "attentry.copyFix", arguments: [explain(f)] } });
    }
    const indent = /^\s*/.exec(lines[f.line - 1] ?? "")![0];
    actions.push({
      title: `Attentry: ignore ${f.rule} here (write the reason after the colon)`, kind: CodeActionKind.QuickFix,
      edit: { changes: { [uri]: [{ range: { start: { line: f.line - 1, character: 0 }, end: { line: f.line - 1, character: 0 } }, newText: `${indent}${commentFor(f.file)} attentry-ignore ${f.rule}: \n` }] } },
    });
    actions.push({ title: `Attentry: not useful (${GUIDES[f.rule]?.name ?? f.rule})`, kind: CodeActionKind.Empty, command: { title: "Not useful", command: "attentry.server.notUseful", arguments: [f.id, f.rule] } });
  }
  return actions;
}

export function hotspotLens(f: Finding): CodeLens {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    // An empty command shows the text without making it a button.
    command: { title: `⚠ Attentry hotspot: ${f.title}. Make small changes and run the tests after each one.`, command: "" },
  };
}
