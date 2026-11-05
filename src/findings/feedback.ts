import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Finding } from "./types.ts";

// "Not useful" clicks, kept in the repo (.attentry/feedback.json) so a team shares them. The
// finding clicked is hidden; a rule people keep marking drops to a hint, the way Google's
// Tricorder turns off checks with more than 10% "not useful" (Sadowski et al., CACM 2018).

const FILE = ".attentry/feedback.json";
const MIN_CLICKS = 2;
const MAX_SHARE = 0.1;

interface Feedback { notUseful: Record<string, string> } // finding id -> rule

async function load(root: string): Promise<Feedback> {
  let text: string;
  try {
    text = await readFile(join(root, FILE), "utf8");
  } catch {
    return { notUseful: {} }; // no file yet: nobody has clicked "not useful"
  }
  const parsed = JSON.parse(text) as Partial<Feedback>;
  return { notUseful: parsed.notUseful ?? {} };
}

export async function markNotUseful(root: string, finding: Pick<Finding, "id" | "rule">): Promise<void> {
  const feedback = await load(root);
  feedback.notUseful[finding.id] = finding.rule;
  await mkdir(dirname(join(root, FILE)), { recursive: true });
  await writeFile(join(root, FILE), `${JSON.stringify(feedback, null, 2)}\n`);
}

export async function applyFeedback(root: string, findings: Finding[]): Promise<Finding[]> {
  const { notUseful } = await load(root);
  const kept = findings.filter((f) => !(f.id in notUseful));
  const clicks = new Map<string, number>();
  for (const rule of Object.values(notUseful)) clicks.set(rule, (clicks.get(rule) ?? 0) + 1);
  for (const [rule, n] of clicks) {
    const mine = kept.filter((f) => f.rule === rule);
    if (n < MIN_CLICKS || n / (n + mine.length) <= MAX_SHARE) continue;
    for (const f of mine) {
      f.confidence = "maybe";
      f.evidence.push(`People here marked ${n} of this rule's findings "not useful", so it's shown as a hint.`);
    }
  }
  return kept;
}
