import { relative } from "node:path";
import { severityOf } from "../findings/severity.ts";
import type { Finding } from "../findings/types.ts";
import { briefLine } from "../report/brief.ts";
import type { Config } from "./config.ts";
import { changeCard } from "./card.ts";
import { fixedSince, keyOf, newSince, type Task } from "./ledger.ts";
import type { ExistingMatch } from "./reuse.ts";

// What Detron says at each moment of an agent's task. Short on purpose: the agent pays for
// every word, so it hears only problems this task added, once each, and nothing when clean.

export interface HookInput {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    content?: string; // Write
    old_string?: string; // Edit
    new_string?: string;
    replace_all?: boolean;
    edits?: { old_string: string; new_string: string; replace_all?: boolean }[]; // MultiEdit
  };
  stop_hook_active?: boolean;
}

export interface HookReply {
  stdout: string; // JSON for the agent, or "" to stay silent
  exitCode: number;
}

const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const PER_EDIT = 5; // lines after one edit
const FOCUS = 3; // lines in a check-in
const MAX_BLOCKED_STOPS = 2; // then let it finish: a block that keeps failing is a loop

const SILENT: HookReply = { stdout: "", exitCode: 0 };
const json = (value: object): HookReply => ({ stdout: `${JSON.stringify(value)}\n`, exitCode: 0 });
const matters = (f: Finding) => ["error", "warning"].includes(severityOf(f));
const worstFirst = (a: Finding, b: Finding) => Number(severityOf(a) !== "error") - Number(severityOf(b) !== "error");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const isEdit = (input: HookInput) => EDIT_TOOLS.test(input.tool_name ?? "");

// After an edit: problems this task added that the agent hasn't been told about yet.
export function afterEdit(input: HookInput, root: string, task: Task, told: Set<string>, findings: Finding[], config: Config): HookReply {
  if (input.tool_input?.file_path) task.editedFiles.add(relative(root, input.tool_input.file_path).replace(/\\/g, "/"));
  task.edits++;
  task.lastEditAt = Date.now();
  const added = newSince(task, findings).filter(matters).sort(worstFirst);
  task.added = added.length;
  const fresh = added.filter((f) => !told.has(keyOf(f)));
  for (const f of fresh) told.add(keyOf(f));
  const lines: string[] = [];
  if (fresh.length) {
    lines.push(`Detron: this edit added ${plural(fresh.length, "problem")}:`, ...fresh.slice(0, PER_EDIT).map(briefLine));
    if (fresh.length > PER_EDIT) lines.push(`…and ${fresh.length - PER_EDIT} more.`);
    lines.push("Fix them before moving on, or say why not. Full steps: `detron explain <file:line>`.");
  }
  // Tests run in the background at check-ins: a failure is told once, on the next edit.
  const tests = task.tests;
  if (tests && (tests.state === "failed" || tests.state === "timeout") && !task.testsTold) {
    task.testsTold = true;
    lines.push(...(lines.length ? [""] : []), `Detron: the tests ${tests.state === "failed" ? "failed" : "didn't finish"} at the last check-in (${tests.label}):`, ...tests.tail.slice(-5).map((l) => `  ${l}`), "Fix them before going on, or say why they fail.");
  }
  if (task.edits - task.lastCheckIn >= config.checkInEvery) {
    task.lastCheckIn = task.edits;
    lines.push(...(lines.length ? [""] : []), ...checkIn(task, findings));
  }
  if (!lines.length) return SILENT;
  const message = lines.join("\n");
  // Block mode: a new security or crash problem comes back to the agent as an error.
  if (config.mode === "block" && fresh.some((f) => severityOf(f) === "error")) return json({ decision: "block", reason: message });
  return json({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } });
}

function checkIn(task: Task, findings: Finding[]): string[] {
  const added = newSince(task, findings);
  const real = added.filter(matters).sort(worstFirst);
  const cleanup = added.length - real.length;
  const fixed = fixedSince(task, findings);
  const head = `Detron check-in after ${plural(task.edits, "edit")}: this task added ${plural(real.length, "problem")}${fixed ? ` and fixed ${fixed}` : ""}.`;
  if (!real.length && !cleanup) return [`${head} Nothing to fix: carry on.`];
  return [
    head,
    ...(real.length ? ["Focus here:", ...real.slice(0, FOCUS).map((f) => `- ${briefLine(f)}`)] : []),
    ...(cleanup ? [`Also ${plural(cleanup, "clean-up item")} (unused or copied code): \`detron scan --changed\` lists them. Clean up in its own step, not mixed with the feature.`] : []),
  ];
}

// When the agent wants to finish: the change card for the person; in block mode, not done
// while the task has added security or crash problems.
export function atStop(input: HookInput, task: Task, findings: Finding[], config: Config): HookReply {
  const added = newSince(task, findings);
  const real = added.filter(matters).sort(worstFirst);
  const errors = real.filter((f) => severityOf(f) === "error");
  if (config.mode === "block" && errors.length && !input.stop_hook_active && task.stopsBlocked < MAX_BLOCKED_STOPS) {
    task.stopsBlocked++;
    return json({ decision: "block", reason: [`Detron: not done yet. This task added ${plural(errors.length, "security or crash problem")}:`, ...errors.slice(0, PER_EDIT).map(briefLine), "Fix them, or tell the person why they're fine."].join("\n") });
  }
  if (!task.edits) return SILENT;
  return json({ systemMessage: changeCard(task, findings) });
}

// The file as it will be after this edit, or undefined if the edit can't be applied to it as it
// is now (then Claude Code will refuse the edit itself).
export function contentAfter(input: HookInput, before: string): string | undefined {
  const t = input.tool_input ?? {};
  if (input.tool_name === "Write") return t.content;
  const edits = input.tool_name === "MultiEdit" ? (t.edits ?? []) : input.tool_name === "Edit" ? [{ old_string: t.old_string ?? "", new_string: t.new_string ?? "", replace_all: t.replace_all }] : [];
  let text = before;
  for (const e of edits) {
    if (!e.old_string || !text.includes(e.old_string)) return undefined;
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string);
  }
  return edits.length ? text : undefined;
}

// Before an edit that adds functions the repo already has: say so, once per pair. Block mode
// refuses only exact copies; anything less sure is a note.
export function beforeEdit(matches: ExistingMatch[], told: Set<string>, config: Config): HookReply {
  const fresh = matches.filter((m) => !told.has(`reuse|${m.candidate}|${m.existing.file}:${m.existing.name}`));
  for (const m of fresh) told.add(`reuse|${m.candidate}|${m.existing.file}:${m.existing.name}`);
  if (!fresh.length) return SILENT;
  // An exported function can be imported as it is; one inside a component or file needs moving
  // to a shared place first.
  const advice = (m: ExistingMatch) => (m.existing.exported ? "import it" : "move it to a shared file and use it from both places");
  const line = (m: ExistingMatch) => `- \`${m.candidate}\`: \`${m.existing.name}\` in ${m.existing.file}:${m.existing.startLine}${m.uses ? ` (used in ${plural(m.uses, "place")})` : ""} has ${m.why}. Instead of a copy, ${advice(m)}.`;
  const message = [
    `Detron: before you add ${fresh.length === 1 ? "this function" : "these functions"}, the repo already has ${fresh.length === 1 ? "one that does this" : "ones that do this"}:`,
    ...fresh.map(line),
    "Reuse it, or say why a new one is needed.",
  ].join("\n");
  if (config.mode === "block" && fresh.some((m) => m.confidence === "sure")) {
    return json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } });
  }
  return json({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } });
}
