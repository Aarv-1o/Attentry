import { filesIn } from "../agent/plan.ts";

// A plan's steps and the files each names, so Attentry can tell when the edits move from one
// step to the next and run the tests then (docs/tests-plan.md, step 4). Claude doesn't have to
// say a step is done.

export interface PlanStep { title: string; files: string[] }

// "## Step 2: the API", "### Phase 1", or top-level "1. Add the route" items.
const HEADING = /^#{2,4}\s+(.*\b(step|phase|part|stage)\b.*|\d+[.):].*)$/i;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

// Steps that name files. Fewer than two: nothing to move between.
export function planSteps(plan: string, allFiles: Set<string>): PlanStep[] {
  const lines = plan.split("\n");
  const byHeading = lines.filter((l) => HEADING.test(l)).length >= 2;
  const starts = (line: string) => (byHeading ? HEADING.test(line) : NUMBERED.test(line));
  const steps: { title: string; text: string }[] = [];
  let open = false; // another heading ("## Files to change", "## Verification") ends a step
  for (const line of lines) {
    if (starts(line)) {
      steps.push({ title: line.replace(/^#+\s*|^\d+[.)]\s*/, "").trim().replace(/[.:]$/, ""), text: line });
      open = true;
    } else if (/^#{1,6}\s/.test(line)) open = false;
    else if (open) steps.at(-1)!.text += `\n${line}`;
  }
  const named = steps.map((s) => ({ title: s.title, files: [...filesIn(s.text, allFiles)] })).filter((s) => s.files.length);
  return named.length >= 2 ? named : [];
}

// "routes/notes.ts" in a plan is src/routes/notes.ts in the repo.
const names = (file: string, planned: string) => file === planned || file.endsWith(`/${planned}`);

// The later step an edited file belongs to, if the edits have moved on: a file of a step after
// `current`, and not one of `current` or before it (a shared file doesn't move anything).
export function stepOf(steps: PlanStep[], current: number, file: string): number | undefined {
  const index = steps.findIndex((s) => s.files.some((p) => names(file, p)));
  if (index <= current) return undefined;
  const earlier = steps.slice(0, current + 1).some((s) => s.files.some((p) => names(file, p)));
  return earlier ? undefined : index;
}
