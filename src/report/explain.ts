import type { Finding } from "../findings/types.ts";
import { formatAgent } from "./agent.ts";

// Everything about the findings on one line: the code in plain words, then the full steps.
// Used by `attentry explain` and the editor's "Copy fix for agent".
export function explainFindings(root: string, here: Finding[]): string {
  const plain = [...new Set(here.flatMap((f) => [f.plain?.does, f.plain?.replacedBy]).filter((t): t is string => !!t))];
  return `${plain.map((t) => `${t}\n`).join("")}${plain.length ? "\n" : ""}${formatAgent(root, here, true)}`;
}

export const findingsOn = (findings: Finding[], file: string, line: number) =>
  findings.filter((f) => f.file === file && f.line <= line && line <= (f.endLine ?? f.line));
