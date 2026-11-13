import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressFor } from "../src/daemon/address.ts";
import type { FunctionInfo } from "../src/index/functions.ts";
import { extractUsage } from "../src/index/usage.ts";
import { detectLanguage, parseSource } from "../src/parse/parse.ts";
import { runLineRules } from "../src/rules/line/index.ts";

// A throwaway repo on disk: { "src/a.ts": "content", ... }.
export async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "attentry-"));
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
export const withClaudeSettings = (settings: object, run: () => Promise<void>) => withHome({ ".claude.json": JSON.stringify(settings) }, run);

// Runs `run` in a home folder of the test's, with these files, and gives it that folder. Node finds
// the home folder in HOME, and on Windows in USERPROFILE: both are set.
export async function withHome(files: Record<string, string>, run: (home: string) => Promise<void>): Promise<void> {
  const home = await makeRepo(files);
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await run(home);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Asks the background Attentry to stop (a build it doesn't know makes it step aside).
export const stopBackground = (root: string) => new Promise<void>((done) => {
  const socket = createConnection(addressFor(root), () => socket.write(`${JSON.stringify({ kind: "ping", build: "test-cleanup" })}\n`));
  socket.on("data", () => socket.end());
  socket.on("close", () => done());
  socket.on("error", () => done());
});

// A stand-in for an agent's own command (a .cmd on Windows): writes down each call, and answers
// `plugin list --json` with `listed`. Named by ATTENTRY_CLAUDE or ATTENTRY_CODEX, so the real
// command on PATH is never the one run; and with its own config folder, so even that couldn't
// touch the person's real Claude Code or Codex.
const AGENT_ENV = { claude: ["ATTENTRY_CLAUDE", "CLAUDE_CONFIG_DIR"], codex: ["ATTENTRY_CODEX", "CODEX_HOME"] } as const;
export async function fakeAgent(name: keyof typeof AGENT_ENV, listed: unknown) {
  const dir = await makeRepo({ "listed.json": JSON.stringify(listed) });
  const log = join(dir, "calls.log");
  await writeFile(join(dir, "fake.mjs"), [
    `import { appendFileSync, readFileSync } from "node:fs";`,
    `const args = process.argv.slice(2).join(" ");`,
    `appendFileSync(${JSON.stringify(log)}, args + "\\n");`,
    `if (args === "plugin list --json") process.stdout.write(readFileSync(${JSON.stringify(join(dir, "listed.json"))}, "utf8"));`,
  ].join("\n"));
  await writeFile(join(dir, name), `#!/bin/sh\nexec node "${join(dir, "fake.mjs")}" "$@"\n`);
  await chmod(join(dir, name), 0o755);
  await writeFile(join(dir, `${name}.cmd`), `@node "%~dp0fake.mjs" %*\r\n`);
  const [command, config] = AGENT_ENV[name];
  const before = { [command]: process.env[command], [config]: process.env[config] };
  process.env[command] = join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  process.env[config] = join(dir, "config");
  return {
    calls: async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean) : []),
    [Symbol.dispose]: () => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
