import { readTexts } from "../../index/texts.ts";
import { HOLE } from "./paths.ts";
import type { ApiCall } from "./types.ts";

// Calls in HTML pages: inline <script> fetches and <form action>. Attentry doesn't parse HTML,
// so this reads the text; it only takes literal URLs.

const FETCH = /\bfetch\(\s*(['"`])([^'"`]*)\1\s*(?:,\s*\{([^}]{0,300}))?/g;
const FORM = /<form\b[^>]*\baction=["']([^"']+)["'][^>]*>/gi;
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

function htmlCalls(text: string): ApiCall[] {
  const calls: ApiCall[] = [];
  for (const m of text.matchAll(FETCH)) {
    const method = m[3] === undefined ? "GET" : (/method:\s*['"](\w+)['"]/.exec(m[3])?.[1]?.toUpperCase() ?? (/method/.test(m[3]) ? undefined : "GET"));
    calls.push({ method, url: m[2]!.replace(/\$\{[^}]*\}/g, HOLE), line: lineAt(text, m.index) });
  }
  for (const m of text.matchAll(FORM)) {
    const method = /\bmethod=["'](\w+)["']/i.exec(m[0])?.[1]?.toUpperCase() ?? "GET";
    calls.push({ method, url: m[1]!, line: lineAt(text, m.index) });
  }
  return calls;
}

export async function htmlCallsIn(root: string, allFiles: string[]): Promise<(ApiCall & { file: string })[]> {
  const pages = await readTexts(root, allFiles.filter((f) => /\.html?$/i.test(f)));
  return [...pages].flatMap(([file, text]) => htmlCalls(text).map((call) => ({ ...call, file })));
}
