import { worthFlagging, type History, type Hotspot } from "../rules/codebase/hotspots.ts";

const SHOWN = 5;
const SHOWN_ALL = 10;
const num = (n: number) => n.toLocaleString("en-US");

// `findings`: how many other Attentry findings each file has, so "clean here first" has a starting point.
export function formatHotspots(history: History, hotspots: Hotspot[], findings: Map<string, number>, showAll: boolean): string {
  if (!history.ok) return `Hotspots: not checked (${history.reason}).\n`;
  const worth = hotspots.filter((h) => worthFlagging(h, findings.has(h.file)));
  if (!worth.length) return "No hotspots found (the files that change most are small and have no findings).\n";
  const shown = worth.slice(0, showAll ? SHOWN_ALL : SHOWN);
  const cells = shown.map((h) => ({
    file: h.file,
    changes: `${h.changes} changes`,
    lines: `${num(h.lines)} lines`,
    found: findings.get(h.file) ? `${findings.get(h.file)} finding${findings.get(h.file) === 1 ? "" : "s"} above` : "",
  }));
  const w = (key: keyof (typeof cells)[number]) => Math.max(...cells.map((c) => c[key].length));
  const lines = cells.map((c, i) =>
    `  ${`${i + 1}.`.padEnd(String(cells.length).length + 1)} ${c.file.padEnd(w("file"))}  ${c.changes.padStart(w("changes"))}  ${c.lines.padStart(w("lines"))}  ${c.found}`.trimEnd(),
  );
  const more = !showAll && worth.length > shown.length ? [`  ${worth.length - shown.length} more with --all.`] : [];
  return [
    `Hotspots: complex files that change often, where changes break things most (from ${history.commits} commits)`,
    "",
    ...lines,
    "     → Not a to-do list. When a task changes one of these: test the part you change first,",
    "       and keep cleanup in its own commit. Messy files that rarely change can wait.",
    ...more,
    "",
  ].join("\n");
}
