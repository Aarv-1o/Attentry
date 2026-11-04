import type { Finding } from "../findings/types.ts";
import type { TestRun } from "./tests.ts";

// What a task started with, so "new" means new in this task: not before it (old issues never
// nag), and not limited to the lines it touched (deleting a caller in one file can make a
// function dead in another). Kept in memory by the background Detron, per agent session.

// Same problem in the same place, even when lines move: titles name the function or route.
export const keyOf = (f: Finding) => `${f.rule}|${f.file}|${f.title}`;

export interface Task {
  started: Map<string, number>; // finding key -> how many there were
  edits: number;
  lastCheckIn: number; // edit count at the last check-in
  editedFiles: Set<string>;
  stopsBlocked: number; // times finishing was blocked: give up after a couple, so it can't loop
  lastEditAt: number; // for the editor's live view
  added: number; // problems (not clean-up) this task had added at its last edit
  tests?: TestRun & { atEdit: number }; // the latest finished run, and the edit count it ran at
  testsTold: boolean; // the agent has heard about the latest failure
  testing?: Promise<TestRun>; // a run going on now
  // Another agent is editing this repo at the same time: only problems in files this task edited
  // are its own. (Alone, a problem anywhere is its own: deleting a caller makes a function dead elsewhere.)
  shared: boolean;
}

const fileOfKey = (key: string) => key.split("|")[1]!;
const ownFile = (task: Task, file: string) => !task.shared || task.editedFiles.has(file);

export function startTask(findings: Finding[]): Task {
  const started = new Map<string, number>();
  for (const f of findings) started.set(keyOf(f), (started.get(keyOf(f)) ?? 0) + 1);
  return { started, edits: 0, lastCheckIn: 0, editedFiles: new Set(), stopsBlocked: 0, lastEditAt: 0, added: 0, testsTold: false, shared: false };
}

// Findings now that weren't there when the task started (counting duplicates: a second
// identical problem is new too).
export function newSince(task: Task, findings: Finding[]): Finding[] {
  const left = new Map(task.started);
  return findings.filter((f) => {
    const n = left.get(keyOf(f)) ?? 0;
    if (n > 0) {
      left.set(keyOf(f), n - 1);
      return false;
    }
    return ownFile(task, f.file);
  });
}

// Problems the task fixed: there at the start, gone now.
export function fixedSince(task: Task, findings: Finding[]): number {
  const now = new Map<string, number>();
  for (const f of findings) now.set(keyOf(f), (now.get(keyOf(f)) ?? 0) + 1);
  let fixed = 0;
  for (const [key, n] of task.started) if (ownFile(task, fileOfKey(key))) fixed += Math.max(0, n - (now.get(key) ?? 0));
  return fixed;
}
