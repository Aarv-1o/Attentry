import { partOf, severityOf, worthChecking } from "../findings/severity.ts";
import type { Finding } from "../findings/types.ts";
import { fixedSince, newSince, type Task } from "./ledger.ts";
import { describeTests } from "./tests.ts";
import { plural } from "../report/common.ts";

// The change card: what a task did, for the person, at the end. Facts only, all from Attentry's
// own records (no AI): the files it changed, the problems it added and fixed, and the tests.

const MAX_FILES = 5;

export function changeCard(task: Task, findings: Finding[], exists?: (file: string) => boolean): string {
  const added = newSince(task, findings).filter((f) => severityOf(f) !== "hint");
  const real = added.filter((f) => severityOf(f) !== "info");
  const cleanup = added.length - real.length;
  const fixed = fixedSince(task, findings, exists);
  const check = newSince(task, findings).filter(worthChecking).length;
  const files = [...task.editedFiles].sort();
  const parts = (["security", "breaks", "database"] as const)
    .map((p) => [p, real.filter((f) => partOf(f) === p).length] as const)
    .filter(([, n]) => n)
    .map(([p, n]) => `${n} ${p === "breaks" ? "will break" : p}`);
  return [
    "Attentry change card",
    `- Changed: ${plural(files.length, "file")}${files.length ? ` (${files.slice(0, MAX_FILES).join(", ")}${files.length > MAX_FILES ? `, +${files.length - MAX_FILES} more` : ""})` : ""}`,
    `- Problems: ${real.length ? `${real.length} added (${parts.join(", ")})` : "none added"}${fixed ? `, ${fixed} fixed` : ""}`,
    ...(cleanup ? [`- Clean-up: ${cleanup} added (unused or copied code)`] : []),
    ...(check ? [`- To check: ${check} route${check === 1 ? "" : "s"} with no auth check of ${check === 1 ? "its" : "their"} own, in an app that sets up auth elsewhere`] : []),
    `- Tests: ${task.testing ? "still running (the sidebar shows the result)" : task.tests && task.tests.atEdit < task.edits ? `${describeTests(task.tests)}, before the last ${plural(task.edits - task.tests.atEdit, "edit")}` : describeTests(task.tests)}`,
    ...(real.length || cleanup || check ? ["See them with `attentry scan --changed` or in the Attentry sidebar."] : []),
  ].join("\n");
}
