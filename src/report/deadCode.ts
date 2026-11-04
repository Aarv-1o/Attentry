import { posix } from "node:path";
import type { DeadFunction } from "../rules/codebase/deadFunctions.ts";
import type { UnusedFile } from "../rules/codebase/unusedFiles.ts";
import type { UnusedPackage } from "../rules/codebase/unusedPackages.ts";
import { hiddenNote, nothingFound, sureness } from "./common.ts";

export interface DeadCode {
  packages: UnusedPackage[];
  files: UnusedFile[];
  functions: DeadFunction[];
}

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const pad = (items: string[]) => Math.max(...items.map((s) => s.length));
const safe = (confidence: string) => sureness(confidence, "safe to remove");

function packagesSection(packages: UnusedPackage[]): string[] {
  if (!packages.length) return [];
  const total = packages.reduce((sum, p) => sum + (p.sizeBytes ?? 0), 0);
  const width = pad(packages.map((p) => p.name));
  const lines = [`  Unused packages (${packages.length}${total ? `, ${megabytes(total)}` : ""})`];
  for (const p of packages) {
    const size = p.sizeBytes ? megabytes(p.sizeBytes).padStart(9) : "".padStart(9);
    lines.push(`     ${p.name.padEnd(width)} ${size}  ${p.dev ? "dev, " : ""}${p.manifest}${safe(p.confidence)}`);
  }
  const byFolder = new Map<string, string[]>();
  for (const p of packages) {
    const folder = posix.dirname(p.manifest);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), p.name]);
  }
  for (const [folder, names] of byFolder) {
    lines.push(`     → ${folder === "." ? "" : `In ${folder}: `}npm uninstall ${names.join(" ")}`);
  }
  return [...lines, ""];
}

function filesSection(files: UnusedFile[]): string[] {
  if (!files.length) return [];
  const width = pad(files.map((f) => f.file));
  const lines = [`  Unused files (${files.length})`];
  for (const f of files) lines.push(`     ${f.file.padEnd(width)}  ${`${f.lines} lines`.padStart(10)}  ${f.reason}${safe(f.confidence)}`);
  return [...lines, ""];
}

function functionsSection(dead: DeadFunction[]): string[] {
  if (!dead.length) return [];
  const where = dead.map((d) => `${d.fn.file}:${d.fn.startLine}  ${d.fn.name}`);
  const width = pad(where);
  return [`  Dead functions (${dead.length})`, ...dead.map((d, i) => `     ${where[i]!.padEnd(width)}  ${d.reason}${safe(d.confidence)}`), ""];
}

export function formatDeadCode(found: DeadCode, showHints: boolean): string {
  const shown = (c: string) => showHints || c !== "maybe";
  const packages = found.packages.filter((p) => shown(p.confidence));
  const files = found.files.filter((f) => shown(f.confidence));
  // A dead file's functions are dead too: listing them again is noise.
  const deadFiles = new Set(found.files.map((f) => f.file));
  const functions = found.functions.filter((d) => shown(d.confidence) && !deadFiles.has(d.fn.file));
  const hidden =
    found.packages.length - packages.length +
    found.files.length - files.length +
    found.functions.filter((d) => !deadFiles.has(d.fn.file)).length - functions.length;

  const lines = [...packagesSection(packages), ...filesSection(files), ...functionsSection(functions)];
  if (!lines.length) return nothingFound("dead code", hidden);
  if (hidden) lines.push(`  ${hiddenNote(hidden)}`, "");
  return `Dead code\n\n${lines.join("\n")}`;
}
