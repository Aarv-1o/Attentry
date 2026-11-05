import { scanFiles, type FileCache, type FileScan } from "./fileScan.ts";
import { isSource, listRepoFiles } from "./files.ts";
import type { FunctionInfo } from "./functions.ts";
import type { FileUsage } from "./usage.ts";

export interface RepoIndex {
  root: string;
  allFiles: string[]; // including configs, styles, docs: for finding references outside code
  files: string[]; // source files Attentry parses
  functions: FunctionInfo[];
  usage: Map<string, FileUsage>; // per file: what it imports and which names it uses
  // Files tree-sitter couldn't fully parse. Their results may be incomplete.
  filesWithSyntaxErrors: string[];
  scans: Map<string, FileScan>; // everything learned from each file on its own
  filesRead: number; // files read this time; the rest came from `cache`
}

// `cache` keeps each file's results between builds (the editor and agent hooks reuse one), so
// only files that changed are read again.
export async function buildIndex(root: string, cache: FileCache = new Map()): Promise<RepoIndex> {
  const allFiles = await listRepoFiles(root);
  const files = allFiles.filter(isSource);
  const filesRead = await scanFiles(root, files, cache);
  const scans = new Map(files.flatMap((file) => (cache.has(file) ? [[file, cache.get(file)!] as const] : [])));
  return {
    root, allFiles, files, scans, filesRead,
    functions: [...scans.values()].flatMap((s) => s.functions),
    usage: new Map([...scans].map(([file, s]) => [file, s.usage])),
    filesWithSyntaxErrors: [...scans].filter(([, s]) => s.syntaxError).map(([file]) => file),
  };
}
