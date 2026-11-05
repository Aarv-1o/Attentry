import { PART_NAMES, PARTS, partOf, severityOf } from "../findings/severity.ts";
import type { Finding } from "../findings/types.ts";

// Short output. For agents (hooks, MCP): one line per finding, errors and warnings only,
// capped, so it costs a few hundred tokens instead of thousands. For people: the same,
// grouped by part, with the code explained in plain words.

export const AGENT_MAX = 10;
const order = (a: Finding, b: Finding) => PARTS.indexOf(partOf(a)) - PARTS.indexOf(partOf(b));

export const briefLine = (f: Finding) => `${f.file}:${f.line} ${severityOf(f)} attentry/${f.rule}: ${f.title}`;

// `all` is the command that lists every finding, for the "…and N more" line.
export function formatForAgent(findings: Finding[], all = "attentry scan --agent"): string {
  const sent = findings.filter((f) => ["error", "warning"].includes(severityOf(f))).sort(order);
  if (!sent.length) return "";
  const shown = sent.slice(0, AGENT_MAX);
  const more = sent.length - shown.length;
  return `${[...shown.map(briefLine), ...(more ? [`…and ${more} more: \`${all}\` lists all of them.`] : []), "Full steps for one: `attentry explain <file:line>`."].join("\n")}\n`;
}

export function formatForPerson(findings: Finding[], hiddenOld: number): string {
  const out: string[] = [];
  for (const part of PARTS) {
    const mine = findings.filter((f) => partOf(f) === part && severityOf(f) !== "hint").sort(order);
    if (!mine.length) continue;
    out.push(`${PART_NAMES[part]} (${mine.length})`);
    for (const f of mine) {
      out.push(`  ${f.file}:${f.line}  ${f.title}`);
      if (f.plain?.does) out.push(`      ${f.plain.does}`);
      if (f.plain?.replacedBy) out.push(`      ${f.plain.replacedBy}`);
    }
    out.push("");
  }
  if (!out.length) out.push("Nothing found in your changes.", "");
  if (hiddenOld) out.push(`${hiddenOld} older finding${hiddenOld === 1 ? "" : "s"} from before this change (\`attentry scan\` shows everything).`);
  return `${out.join("\n").trimEnd()}\n`;
}
