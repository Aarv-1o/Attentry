import { takes, type CrossStack, type MissingRoute, type UnusedRoute } from "../rules/crossStack/check.ts";
import { hiddenNote, sureness } from "./common.ts";

const MAX_SHOWN = 8;
const where = (file: string, line: number) => `${file}:${line}`;
const pad = (items: string[]) => Math.max(...items.map((s) => s.length));

function section(title: string, rows: { at: string; what: string; note: string; confidence: string }[], advice?: string): string[] {
  if (!rows.length) return [];
  const atWidth = pad(rows.slice(0, MAX_SHOWN).map((r) => r.at));
  const whatWidth = pad(rows.slice(0, MAX_SHOWN).map((r) => r.what));
  const lines = [`  ${title} (${rows.length})`];
  for (const r of rows.slice(0, MAX_SHOWN)) lines.push(`     ${r.at.padEnd(atWidth)}  ${r.note ? `${r.what.padEnd(whatWidth)}  ${r.note}` : r.what}${sureness(r.confidence)}`);
  if (rows.length > MAX_SHOWN) lines.push(`     …and ${rows.length - MAX_SHOWN} more (--json lists all)`);
  if (advice) lines.push(`     → ${advice}`);
  return [...lines, ""];
}

const call = (m: MissingRoute) => `${m.method ?? "?"} ${m.path.text}`;

function missingRow(m: MissingRoute) {
  const near = m.closest && `${m.closest.method} ${m.closest.path.text} (${where(m.closest.file, m.closest.line)})`;
  const note = near ? `No such route. Did you mean ${near}?` : "No route in this repo has this path.";
  return { at: where(m.file, m.line), what: call(m), note, confidence: m.confidence };
}

function wrongMethodRow(m: MissingRoute) {
  const route = m.closest!;
  return { at: where(m.file, m.line), what: call(m), note: `${takes(m)} (${where(route.file, route.line)}).`, confidence: m.confidence };
}

function unusedRow(u: UnusedRoute) {
  return { at: where(u.route.file, u.route.line), what: `${u.route.method} ${u.route.path.text}`, note: "", confidence: u.confidence };
}

export function formatCrossStack(found: CrossStack, showHints: boolean): string {
  if (!found.routes || !found.calls) {
    const missing = !found.routes ? "no API routes" : "no calls to its API";
    return `Frontend and backend: not checked (${missing} found in this repo).\n`;
  }
  const shown = (c: string) => showHints || c !== "maybe";
  const missing = found.missing.filter((m) => shown(m.confidence));
  const unused = found.unused.filter((u) => shown(u.confidence));
  const hidden = found.missing.length - missing.length + found.unused.length - unused.length;
  const lines = [
    ...section("Calls to routes that don't exist", missing.filter((m) => m.kind === "missing-route").map(missingRow)),
    ...section("Calls with the wrong method", missing.filter((m) => m.kind === "wrong-method").map(wrongMethodRow)),
    ...section("Routes nothing calls", unused.map(unusedRow), "Delete it, unless something outside this repo calls it (an app, a webhook)."),
  ];
  const checked = `${found.calls} calls checked against ${found.routes} routes`;
  if (!lines.length) {
    return `No frontend/backend mismatches found (${checked}${hidden ? `; ${hiddenNote(hidden).replace(/\.$/, "")}` : ""}).\n`;
  }
  if (hidden) lines.push(`  ${hiddenNote(hidden)}`, "");
  return `Frontend and backend (${checked})\n\n${lines.join("\n")}`;
}
