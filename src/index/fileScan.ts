import { join } from "node:path";
import { functionFacts, type FunctionFacts } from "./facts.ts";
import { inBatches, stampOf } from "./texts.ts";
import { extractFunctions, type FunctionInfo } from "./functions.ts";
import { extractUsage, type FileUsage } from "./usage.ts";
import { supportFor } from "../languages/index.ts";
import { parseFile } from "../parse/parse.ts";
import { indentComplexity, stringRows, type FileSize } from "../rules/codebase/hotspots.ts";
import type { FileApi } from "../rules/crossStack/types.ts";
import { runLineRules, type LineFinding } from "../rules/line/index.ts";

// What Attentry learns from one file on its own: 95% of a scan's time. Kept in memory between
// scans (never on disk) and redone only for files whose size or modified time changed, so a
// re-check after an edit reads one file, not the repo.

export interface FileScan {
  stamp: string; // size and modified time when it was read
  functions: FunctionInfo[];
  usage: FileUsage;
  syntaxError: boolean;
  lines: LineFinding[];
  api: FileApi;
  size: FileSize;
  facts: FunctionFacts[];
}

export type FileCache = Map<string, FileScan>;

async function scanFile(path: string, file: string, stamp: string): Promise<FileScan | undefined> {
  const parsed = await parseFile(path);
  if (!parsed) return undefined;
  try {
    const usage = extractUsage(parsed);
    return {
      stamp,
      functions: extractFunctions(parsed, file),
      usage,
      syntaxError: parsed.tree.rootNode.hasError,
      lines: await runLineRules(parsed, file, usage.imports.map((i) => i.source)),
      api: supportFor(parsed.language).extractApi(parsed.tree.rootNode, file),
      // The file as written: an Astro template's nesting is complexity too.
      size: indentComplexity(parsed.original ?? parsed.source, stringRows(parsed.tree.rootNode)),
      facts: functionFacts(parsed, file),
    };
  } finally {
    parsed.tree.delete();
  }
}

// Brings `cache` up to date with `files`: rereads changed files, drops deleted ones.
// Returns how many files were read.
export async function scanFiles(root: string, files: string[], cache: FileCache): Promise<number> {
  const wanted = new Set(files);
  for (const file of cache.keys()) if (!wanted.has(file)) cache.delete(file);
  let read = 0;
  // Which files changed: every file's stamp at once. Parsing the changed ones stays one at a time.
  const stamps = await inBatches(files, (file) => stampOf(join(root, file)));
  for (const [i, file] of files.entries()) {
    const path = join(root, file);
    const stamp = stamps[i];
    if (!stamp) {
      cache.delete(file);
      continue;
    }
    if (cache.get(file)?.stamp === stamp) continue;
    const scanned = await scanFile(path, file, stamp);
    read++;
    if (scanned) cache.set(file, scanned);
    else cache.delete(file);
  }
  return read;
}
