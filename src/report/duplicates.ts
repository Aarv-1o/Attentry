import type { FunctionInfo } from "../index/functions.ts";
import type { CopyDifferences, LineChange } from "../rules/codebase/differences.ts";
import type { DuplicateGroup } from "../rules/codebase/duplicates.ts";
import type { Confidence } from "../rules/confidence.ts";
import { hideSecrets } from "../rules/security/secrets.ts";
import { hiddenNote, nothingFound } from "./common.ts";

const ADVICE: Record<DuplicateGroup["kind"], Partial<Record<Confidence, string>>> = {
  exact: { sure: "Keep one, import it everywhere else." },
  similar: {
    likely: "These do the same job. If they should behave the same, keep one.",
    maybe: "Same structure, different values. Could become one helper with a parameter.",
  },
  "cross-language": {
    likely: "Same logic in two languages. Decide which side owns it.",
    maybe: "Same name in two languages. Check whether they do the same thing.",
  },
};

const HEADINGS: Record<Confidence, string> = {
  sure: "Copies",
  likely: "Likely copies",
  maybe: "Hints",
};

function title(group: DuplicateGroup): string {
  const names = [...new Set(group.functions.map((f) => f.name))];
  const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")}…` : names.join(", ");
  return `${shown} (${group.functions.length} copies)`;
}

function location(fn: FunctionInfo): string {
  return `${fn.file}:${fn.startLine}  ${fn.name}`;
}

function quote(value: string): string {
  const oneLine = hideSecrets(value.replace(/\s+/g, " "));
  const short = oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
  return short.includes('"') ? `'${short}'` : `"${short}"`;
}

const MAX_CHANGES_SHOWN = 3;
const trimmed = (text: string) => {
  const t = hideSecrets(text.trim());
  return t.length > 70 ? `${t.slice(0, 70)}…` : t;
};

const valuesIn = (text: string) => (text.match(/"[^"]*"|'[^']*'|`[^`]*`|\b\d+(\.\d+)?\b/g) ?? []).join(" ");

// Most telling first: a line whose values differ ("Just now" vs "just now", 45 vs 1),
// then other rewritten lines, then lines only one side has.
const rank = (c: LineChange) => {
  if (!c.base || !c.copy) return 2;
  return valuesIn(c.base.text) !== valuesIn(c.copy.text) ? 0 : 1;
};

function differencesSection(diff: CopyDifferences): string[] {
  const lines = [`     What differs from ${diff.base.file}:${diff.base.startLine} ${diff.base.name}:`];
  for (const { fn, changes } of diff.copies) {
    lines.push(`       ${fn.file}:${fn.startLine} ${fn.name}`);
    const shown = [...changes].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_CHANGES_SHOWN);
    for (const c of shown) {
      if (c.base && c.copy) {
        lines.push(`         ${String(c.copy.line).padStart(5)}: ${trimmed(c.copy.text)}`);
        lines.push(`           instead of: ${trimmed(c.base.text)}`);
      } else if (c.copy) {
        lines.push(`         ${String(c.copy.line).padStart(5)}: ${trimmed(c.copy.text)}   (only here)`);
      } else if (c.base) {
        lines.push(`         missing: ${trimmed(c.base.text)}`);
      }
    }
    if (changes.length > shown.length) lines.push(`         …and ${changes.length - shown.length} more`);
  }
  return lines;
}

export function formatDuplicates(
  groups: DuplicateGroup[],
  showHints: boolean,
  differences: Map<DuplicateGroup, CopyDifferences> = new Map(),
  unusedFiles: Set<string> = new Set(),
  appOf: (file: string) => string = () => "",
): string {
  const lines: string[] = [];
  let hidden = 0;
  // A drifted group often contains an exact group too: point back to it instead of hiding either.
  const sureNumber = new Map<FunctionInfo, number>();
  groups.filter((g) => g.confidence === "sure").forEach((g, i) => g.functions.forEach((f) => sureNumber.set(f, i + 1)));
  for (const level of ["sure", "likely", "maybe"] as const) {
    const inLevel = groups.filter((g) => g.confidence === level);
    if (!inLevel.length) continue;
    if (level === "maybe" && !showHints) {
      hidden = inLevel.length;
      continue;
    }
    lines.push(`${HEADINGS[level]} (${inLevel.length})`, "");
    inLevel.forEach((group, i) => {
      lines.push(`  ${i + 1}. ${title(group)}`);
      for (const fn of group.functions) {
        const seeAlso = level !== "sure" && sureNumber.has(fn) ? `  (see Copies #${sureNumber.get(fn)})` : "";
        const unused = unusedFiles.has(fn.file) ? "  (in a file that looks unused)" : "";
        lines.push(`     ${location(fn)}${seeAlso}${unused}`);
      }
      if (group.sharedValues.length) lines.push(`     Same wording: ${group.sharedValues.slice(0, 3).map(quote).join(", ")}`);
      if (group.kind === "exact" && new Set(group.functions.map((f) => f.name)).size > 1) {
        lines.push("     Identical apart from names.");
      }
      const diff = differences.get(group);
      if (diff) lines.push(...differencesSection(diff));
      // A browser app and its server (each with its own package.json) can't import from each other.
      const apps = new Set(group.functions.map((f) => appOf(f.file)));
      const advice = group.kind === "exact" && apps.size > 1 ? `They're in different apps (${[...apps].map((a) => a.replace(/\/$/, "") || "the root").join(", ")}), which can't import from each other: move it to a package they share, or keep both and change them together.` : ADVICE[group.kind][level] ?? "";
      lines.push(`     → ${advice}`, "");
    });
  }
  if (!lines.length) return nothingFound("copies", hidden);
  if (hidden) lines.push(hiddenNote(hidden), "");
  return lines.join("\n");
}
