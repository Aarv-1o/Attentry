import { partOf, severityOf } from "../findings/severity.ts";
import type { Finding } from "../findings/types.ts";
import { fixedSince, newSince, type Task } from "./ledger.ts";
import { describeTests } from "./tests.ts";

// The change card: what a task did, for the person, at the end. Facts only, all from Detron's
// own records (no AI): the files it changed, the problems it added and fixed, and the tests.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const MAX_FILES = 5;

export function changeCard(task: Task, findings: Finding[]): string {
  const added = newSince(task, findings).filter((f) => severityOf(f) !== "hint");
  const real = added.filter((f) => severityOf(f) !== "info");
  const cleanup = added.length - real.length;
  const fixed = fixedSince(task, findings);
  const files = [...task.editedFiles].sort();
  const parts = (["security", "breaks", "database"] as const)
    .map((p) => [p, real.filter((f) => partOf(f) === p).length] as const)
    .filter(([, n]) => n)
    .map(([p, n]) => `${n} ${p === "breaks" ? "will break" : p}`);
  return [
    "Detron change card",
    `- Changed: ${plural(files.length, "file")}${files.length ? ` (${files.slice(0, MAX_FILES).join(", ")}${files.length > MAX_FILES ? `, +${files.length - MAX_FILES} more` : ""})` : ""}`,
    `- Problems: ${real.length ? `${real.length} added (${parts.join(", ")})` : "none added"}${fixed ? `, ${fixed} fixed` : ""}`,
    ...(cleanup ? [`- Clean-up: ${cleanup} added (unused or copied code)`] : []),
    `- Tests: ${task.testing ? "still running (the sidebar shows the result)" : task.tests && task.tests.atEdit < task.edits ? `${describeTests(task.tests)}, before the last ${plural(task.edits - task.tests.atEdit, "edit")}` : describeTests(task.tests)}`,
    ...(real.length || cleanup ? ["See them with `detron scan --changed` or in the Detron sidebar."] : []),
  ].join("\n");
}
