import { isGenerated, isSource, isTestFile } from "../../index/files.ts";
import type { FunctionInfo } from "../../index/functions.ts";
import type { RepoIndex } from "../../index/repo.ts";
import { readTexts } from "../../index/texts.ts";
import { supportFor } from "../../languages/index.ts";
import type { Confidence } from "../confidence.ts";

export interface DeadFunction {
  fn: FunctionInfo;
  confidence: Confidence;
  reason: string;
}

// Exports that frameworks call by name (Next.js, Remix, SvelteKit, editor extensions...).
export const FRAMEWORK_EXPORTS = new Set([
  "getServerSideProps", "getStaticProps", "getStaticPaths", "generateMetadata", "generateStaticParams",
  "loader", "action", "meta", "links", "headers", "middleware", "load",
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  "activate", "deactivate", // VS Code (and Cursor, Windsurf...) extensions
]);

function add(map: Map<string, number>, name: string, n: number) {
  map.set(name, (map.get(name) ?? 0) + n);
}

// The words in each non-code file (HTML, docs, configs), kept between scans until the file changes.
const wordsKept = new Map<string, { text: string; words: Set<string> }>();
function wordsOf(path: string, text: string): Set<string> {
  let kept = wordsKept.get(path);
  if (kept?.text !== text) wordsKept.set(path, (kept = { text, words: new Set(text.match(/[A-Za-z_$][\w$]*/g)) }));
  return kept.words;
}

export async function findDeadFunctions(index: RepoIndex): Promise<DeadFunction[]> {
  const uses = new Map<string, number>();
  const testUses = new Map<string, number>();
  for (const [file, usage] of index.usage) {
    for (const [name, n] of usage.names) add(isTestFile(file) ? testUses : uses, name, n);
  }
  const definitions = new Map<string, number>();
  for (const fn of index.functions) if (!isTestFile(fn.file)) add(definitions, fn.name, 1);

  // Plain HTML calls functions by name: <button onclick="sendMessage()">.
  const otherTexts = await readTexts(index.root, index.allFiles.filter((f) => !isSource(f)));
  const otherWords = [...otherTexts].map(([file, text]) => wordsOf(`${index.root}/${file}`, text));
  const mentionedOutsideCode = (name: string) => otherWords.some((words) => words.has(name));

  const dead: DeadFunction[] = [];
  for (const fn of index.functions) {
    if (isTestFile(fn.file) || isGenerated(fn.file)) continue; // a generator writes what it writes
    // Methods, object properties, decorated and default-exported functions are called by
    // frameworks and dynamic code we can't see.
    if (fn.kind !== "function" || fn.decorated || fn.defaultExport || fn.name.startsWith("__")) continue;
    if (fn.exported && FRAMEWORK_EXPORTS.has(fn.name)) continue;
    // Each definition counts its own name once; anything beyond that is a use.
    if ((uses.get(fn.name) ?? 0) > (definitions.get(fn.name) ?? 0)) continue;
    if (mentionedOutsideCode(fn.name)) continue;

    if ((testUses.get(fn.name) ?? 0) > 0) {
      dead.push({ fn, confidence: "likely", reason: "Only tests use it. Delete it and its tests?" });
    } else if (fn.exported) {
      dead.push({ fn, confidence: "likely", reason: supportFor(fn.language).unusedExportReason });
    } else {
      dead.push({ fn, confidence: "sure", reason: "Nothing uses it." });
    }
  }
  return dead;
}
