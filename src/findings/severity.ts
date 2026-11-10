import type { Finding } from "./types.ts";

// How loud a finding is, the same way everywhere (editor, CLI, agent output). Editors' agents
// read only errors and warnings (Cursor passes Error and Warning, not Info or Hint), so clean-up
// stays "info": the person sees it, and no agent credits go to it.

export type Severity = "error" | "warning" | "info" | "hint";
export type Part = "security" | "breaks" | "database" | "cleanup";

// Error handling that hides failures: these break things for users, unlike style issues.
export const HIDES_FAILURES = new Set(["empty-catch", "catch-only-logs", "catch-returns-default"]);

export function partOf(f: Finding): Part {
  if (f.category === "security") return "security";
  // A route nothing calls breaks nothing: it's clean-up. A call to a route that isn't there breaks.
  if (f.category === "crash" || (f.category === "frontend-backend" && f.rule !== "unused-route") || HIDES_FAILURES.has(f.rule)) return "breaks";
  if (f.category === "database") return "database";
  return "cleanup";
}

export function severityOf(f: Finding): Severity {
  if (f.confidence === "maybe") return "hint";
  const part = partOf(f);
  if (part === "security" || f.category === "crash") return "error";
  if (part === "breaks" || part === "database") return "warning";
  return "info";
}

// A problem to tell the agent about: security, crash, will break, database. Not clean-up or hints.
export const isProblem = (f: Finding) => ["error", "warning"].includes(severityOf(f));

export const PART_NAMES: Record<Part, string> = { security: "Security", breaks: "Will break", database: "Database", cleanup: "Clean-up" };
export const PARTS = Object.keys(PART_NAMES) as Part[];
