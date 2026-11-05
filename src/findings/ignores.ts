import type { Finding } from "./types.ts";

// `// attentry-ignore missing-ownership-check: admins only, checked by the gateway` on a finding's
// line or the line above hides it. The reason is required: an ignore with no reason is an
// easy way for an agent to silence a real problem, so it doesn't count.

const IGNORE = /(?:\/\/|#|\/\*|\{\/\*)\s*attentry-ignore\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s*(?::\s*(.*?))?\s*(?:\*\/\s*\}?)?\s*$/;

export type Ignore = { reason: true } | { reason: false; line: number } | undefined;

// Files' lines, split once.
export function ignoreChecker(texts: Map<string, string>): (file: string, line: number, rule: string) => Ignore {
  const lines = new Map<string, string[]>();
  return (file, line, rule) => {
    let text = lines.get(file);
    if (!text) lines.set(file, (text = texts.get(file)?.split("\n") ?? []));
    for (const n of [line, line - 1]) {
      const m = IGNORE.exec(text[n - 1] ?? "");
      if (!m || !m[1]!.split(/\s*,\s*/).includes(rule)) continue;
      return m[2]?.trim() ? { reason: true } : { reason: false, line: n };
    }
    return undefined;
  };
}

export function applyIgnores(findings: Finding[], texts: Map<string, string>): Finding[] {
  const ignored = ignoreChecker(texts);
  return findings.filter((f) => {
    const found = ignored(f.file, f.line, f.rule);
    if (found?.reason) return false;
    if (found) f.evidence.push(`Line ${found.line} tries to ignore this, but gives no reason: write one after the colon, or fix it.`);
    return true;
  });
}
