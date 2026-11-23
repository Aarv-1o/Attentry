import type { FunctionFacts } from "../index/facts.ts";

// Facts about a function, said in plain words: "`resetPlayer(player)`: when `player.health` is
// 0 or less, it calls `player.die()` and sets `player.health` to `100`." Built from the code,
// not a model, so it is only as clear as the code's names.

const code = (text: string) => `\`${text}\``;
// "~a text": the fact is already in words. Numbers read fine as they are.
const value = (text: string) => (text.startsWith("~") ? text.slice(1) : /^-?\d+(\.\d+)?$|^empty$/.test(text) ? text : code(text));

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const COMPARISONS: [RegExp, string, string][] = [
  // pattern, as words, negated as words
  [/^(.+?)\s*<=\s*(.+)$/, "is $2 or less", "is above $2"],
  [/^(.+?)\s*>=\s*(.+)$/, "is $2 or more", "is below $2"],
  [/^(.+?)\s*<\s*(.+)$/, "is below $2", "is $2 or more"],
  [/^(.+?)\s*>\s*(.+)$/, "is above $2", "is $2 or less"],
  [/^(.+?)\s*(?:!==|!=|is not)\s*(.+)$/, "isn't $2", "is $2"],
  [/^(.+?)\s*(?:===|==|\bis\b)\s*(.+)$/, "is $2", "isn't $2"],
];

// One condition in words: `player.health <= 0` -> "`player.health` is 0 or less".
function part(text: string, negate: boolean): string {
  const t = text.trim().replace(/^\((.*)\)$/, "$1");
  // Callbacks and chained comparisons don't read well as words: show the code.
  if (/=>|lambda/.test(t) || (t.match(/[<>]=?|[!=]==?/g) ?? []).length > 1) return negate ? `${code(t)} is false` : code(t);
  for (const [pattern, words, negated] of COMPARISONS) {
    const m = pattern.exec(t);
    if (!m || /[&|]|\band\b|\bor\b/.test(t)) continue;
    const said = (negate ? negated : words).replace("$2", value(m[2]!.trim().replace(/^None$|^null$|^undefined$/, "empty")));
    return `${code(m[1]!.trim())} ${said}`;
  }
  // A call is true or false; a value is set or missing.
  const [yes, no] = /\)$/.test(t) ? ["is true", "is false"] : ["is set", "is missing"];
  const not = /^(!|not\s+)(.+)$/.exec(t);
  if (not) return `${code(not[2]!)} ${negate ? yes : no}`.replace(/\) is set$/, ") is true").replace(/\) is missing$/, ") is false");
  if (/^[\w$.]+(\(.*\))?$/.test(t)) return `${code(t)} ${negate ? no : yes}`;
  return negate ? `${code(t)} is false` : code(t);
}

export function condition(text: string): string {
  const negate = text.startsWith("NOT ");
  const t = negate ? text.slice(4) : text;
  const and = t.split(/\s*(?:&&|\band\b)\s*/);
  const or = t.split(/\s*(?:\|\||\bor\b)\s*/);
  // Negating "a and b" gives "a or b" in words (and the other way round).
  if (and.length > 1 && or.length === 1) return and.map((p) => part(p, negate)).join(negate ? " or " : " and ");
  if (or.length > 1 && and.length === 1) return or.map((p) => part(p, negate)).join(negate ? " and " : " or ");
  return part(t, negate);
}

// "calls a() and b(), and returns x": a comma before the last step when steps have their own "and".
const steps = (parts: string[]) => (parts.length > 1 && parts.some((p) => p.includes(" and ")) ? `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}` : list(parts));

function actions(f: FunctionFacts): string[] {
  const out: string[] = [];
  // A call whose result is returned is said once, by the return.
  const calls = f.returns.length === 1 ? f.calls.filter((c) => !f.returns[0]!.replace(/\([^()]*\)/g, "()").startsWith(c)) : f.calls;
  if (calls.length) out.push(`calls ${list(calls.slice(0, 3).map((c) => code(`${c}()`)))}${calls.length > 3 ? ` and ${calls.length - 3} more` : ""}`);
  for (const c of f.changes.slice(0, 2)) out.push(`sets ${code(c.target)} to ${value(c.value)}`);
  const r = f.returns[0];
  if (f.returns.length === 1) out.push(r!.startsWith("<") ? `shows ${code(r!)}` : r!.startsWith("{ ") ? `returns an object ${code(r!)}` : `returns ${value(r!)}`);
  else if (f.returns.length > 1) out.push(`returns one of ${f.returns.length} values`);
  return out;
}

const LONG_LINES = 60;
const MANY_STEPS = 12;

export function describe(f: FunctionFacts): string | undefined {
  const parts = actions(f);
  if (!parts.length) return undefined;
  const who = f.name ? code(`${f.name}(${f.params})`) : "This code";
  const lines = f.endLine - f.startLine + 1;
  if (lines > LONG_LINES || f.steps > MANY_STEPS) {
    // The step count only when it's what makes it long: "128 lines with 1 steps" read as a typo.
    return `${who} is ${lines} lines${f.steps > MANY_STEPS ? ` with ${f.steps} steps` : ""}: it ${steps(parts)}. That's a lot for one function.`;
  }
  return `${who}: ${f.when ? `when ${condition(f.when)}, it ` : "it "}${steps(parts)}.`;
}

export interface Candidate {
  facts: FunctionFacts;
  uses: number; // times its name is used outside its own definition
}

const SHARED_MIN = 2;
const SHARED_SHARE = 0.5;

// A used function that touches the same fields and calls as an unused one: likely what replaced it.
export function likelyReplacement(dead: FunctionFacts, candidates: Candidate[]): string | undefined {
  const own = new Set(dead.touches);
  if (own.size < SHARED_MIN) return undefined;
  let best: { c: Candidate; shared: string[]; score: number } | undefined;
  for (const c of candidates) {
    if (!c.uses || !c.facts.name || c.facts.name === dead.name) continue;
    const shared = c.facts.touches.filter((t) => own.has(t));
    const score = shared.length / own.size + (c.facts.file === dead.file ? 0.01 : 0);
    if (shared.length >= SHARED_MIN && score >= SHARED_SHARE && (!best || score > best.score)) best = { c, shared, score };
  }
  if (!best) return undefined;
  const called = new Set(dead.calls.map((c) => c.replace(/\(\)/g, "").split(".").at(-1)));
  const said = best.shared.slice(0, 3).map((t) => code(called.has(t) ? `${t}()` : t));
  const { facts, uses } = best.c;
  return `Probably replaced by ${code(facts.name!)} (${facts.file}:${facts.startLine}): it also uses ${list(said)}, and it's used in ${uses} place${uses === 1 ? "" : "s"}.`;
}
