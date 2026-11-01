import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunctionInfo } from "../src/index/functions.ts";
import { extractUsage } from "../src/index/usage.ts";
import { detectLanguage, parseSource } from "../src/parse/parse.ts";
import { runLineRules } from "../src/rules/line/index.ts";

// A throwaway repo on disk: { "src/a.ts": "content", ... }.
export async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "detron-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

// Findings for one file, as "line rule confidence".
export async function check(file: string, source: string, rule?: string): Promise<string[]> {
  const language = detectLanguage(file)!;
  const tree = await parseSource(source, language);
  try {
    const parsed = { path: file, language, source, tree };
    return (await runLineRules(parsed, file, extractUsage(parsed).imports.map((i) => i.source)))
      .filter((f) => !rule || f.rule === rule)
      .map((f) => `${f.line} ${f.rule} ${f.confidence}`);
  } finally {
    tree.delete();
  }
}

// A FunctionInfo for report tests, with sensible defaults.
export const fakeFunction = (overrides: Partial<FunctionInfo> & Pick<FunctionInfo, "name" | "file">): FunctionInfo => ({
  startLine: 3, endLine: 12, language: "typescript", params: [], className: undefined, kind: "function",
  decorated: false, defaultExport: false, exported: false, async: false, nesting: 0, unusedParams: [],
  passedAsValue: false, shape: ["internal"],
  ...overrides,
});

// Runs `run` with Claude Code's settings file (~/.claude.json) in a home folder of the test's.
// Node finds the home folder in HOME, and on Windows in USERPROFILE: both are set.
export async function withClaudeSettings(settings: object, run: () => Promise<void>): Promise<void> {
  const home = await makeRepo({ ".claude.json": JSON.stringify(settings) });
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
