// "1 file", "3 files".
export const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

export const hiddenNote = (count: number) =>
  `${count} more hint${count === 1 ? "" : "s"} hidden. Run with --all to see them.`;

// "No dead code found." or, when only hints exist, "No dead code found (2 more hints hidden. …)."
export const nothingFound = (what: string, hidden: number) =>
  hidden ? `No ${what} found (${hiddenNote(hidden).replace(/\.$/, "")}).\n` : `No ${what} found.\n`;

// How sure a line is, after it: "(safe to fix)" for sure ones, "(hint)" for ones shown with --all.
export const sureness = (confidence: string, safe?: string) =>
  confidence === "sure" && safe ? `  (${safe})` : confidence === "maybe" ? "  (hint)" : "";
