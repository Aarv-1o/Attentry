import { nameWords } from "../rules/codebase/duplicates.ts";
import type { ScanResult } from "../scan/scan.ts";
import { plural } from "../report/common.ts";
import { sameWord, similarFunctions, words } from "./tools.ts";

// When the person sends a request: code the repo already has that it's about, so Claude plans
// with it from the start instead of finding it (or not) while it explores. Strict, because a
// request has many words: a function only when its whole name (two words or more) is in the
// request, a route only when a word of its path is. Nothing for a short request.

const MIN_WORDS = 4;
const MAX_FUNCTIONS = 5;
const MAX_ROUTES = 5;
// Path words every API has: they say nothing about what a route is for.
const GENERIC = new Set(["api", "v1", "v2", "v3", "app", "admin", "public", "internal", "auth"]);

export function relatedCode(prompt: string, scan: ScanResult): string[] {
  const asked = words(prompt);
  if (asked.length < MIN_WORDS) return [];
  const functions = similarFunctions(prompt, scan.index)
    .filter(({ fn }) => {
      const name = words(nameWords(fn.name));
      return name.length >= 2 && name.every((n) => asked.some((w) => sameWord(n, w)));
    })
    .slice(0, MAX_FUNCTIONS)
    .map(({ fn, uses }) => `\`${fn.name}\` in ${fn.file}:${fn.startLine} (used in ${plural(uses, "place")})`);
  const routes = scan.crossStack.allRoutes
    .filter((r) => r.path.segments.some((s) => s.length >= 3 && !GENERIC.has(s) && words(s).some((p) => asked.some((w) => sameWord(p, w)))))
    .slice(0, MAX_ROUTES)
    .map((r) => `${r.method} ${r.path.text} in ${r.file}:${r.line}`);
  return [...functions, ...routes];
}

export const relatedMessage = (items: string[]) =>
  ["Attentry: the repo already has code related to this request. Reuse or extend it rather than writing it again:", ...items.map((i) => `- ${i}`)].join("\n");
