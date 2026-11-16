import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { stopBackground } from "../daemon/client.ts";
import type { Agent } from "./heard.ts";

// Test connection: a session with one known bad edit, sent through the very hook command the agent
// runs, in a throwaway folder. Connected only says the hooks are installed; this says they answer.
// Whether the agent calls them in its sessions is the "heard" check's job: a test can't start one.

// Set for the hooks a test runs: they aren't the agent running them.
export const TEST_EDIT = "ATTENTRY_TEST_EDIT";

const FILE = "server.js";
const PLANTED = `const jwtSecret = process.env.JWT_SECRET || "attentry-test-secret";\nmodule.exports = { jwtSecret };\n`;
const SESSION = "attentry-test-connection";
const HOOK_TIMEOUT_MS = 60_000; // what the agents give a hook
const run = promisify(execFile);

export type ConnectionTest = { ok: boolean; text: string };

// The edit as each agent reports it: Claude Code's Write, Codex's apply_patch.
function editInput(agent: Agent, folder: string) {
  const common = { hook_event_name: "PostToolUse", session_id: SESSION, cwd: folder };
  if (agent === "claude") return { ...common, tool_name: "Write", tool_input: { file_path: join(folder, FILE), content: PLANTED } };
  const patch = ["*** Begin Patch", `*** Add File: ${FILE}`, ...PLANTED.trimEnd().split("\n").map((l) => `+${l}`), "*** End Patch"].join("\n");
  return { ...common, tool_name: "apply_patch", tool_input: { command: patch } };
}

type Ran = { code: number | string | null; stdout: string; stderr: string; missing?: boolean };

// `node` from the PATH, as the agents start their hooks.
async function runHook(args: string[], input: object, folder: string): Promise<Ran> {
  const running = run("node", args, { cwd: folder, env: { ...process.env, [TEST_EDIT]: "1", CLAUDE_PROJECT_DIR: folder }, windowsHide: true, timeout: HOOK_TIMEOUT_MS });
  running.child.stdin?.end(JSON.stringify(input));
  try {
    return { code: 0, ...(await running) };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return { code: e.code ?? null, stdout: e.stdout ?? "", stderr: e.stderr || e.message, missing: e.code === "ENOENT" };
  }
}

const told = (stdout: string): string => {
  try {
    return (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return ""; // not the hook's JSON: said below as a hook that didn't answer
  }
};

// What went wrong, in one line. Node starts a crash with where it happened: the line naming the
// error says more.
function failure(ran: Ran): ConnectionTest {
  if (ran.missing) return { ok: false, text: "`node` isn't found from here, and the hooks run with it. Install Node.js, or add it to your PATH, then restart the editor." };
  const lines = ran.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const error = lines.find((l) => /^(\w*Error|Attentry)\b/.test(l)) ?? lines.at(-1);
  if (error) return { ok: false, text: `Attentry's hook failed: ${error}` };
  return { ok: false, text: ran.code !== 0 ? `Attentry's hook stopped (exit code ${ran.code}) without an answer.` : "Attentry's hook ran, but didn't catch the planted secret." };
}

// `args`: the hook command after `node`, as the agent's hook settings name it.
export async function testConnection(agent: Agent, args: string[]): Promise<ConnectionTest> {
  const folder = await mkdtemp(join(tmpdir(), "attentry-test-"));
  try {
    // The session starts on an empty folder, so the planted secret is new in its task.
    const start = await runHook(args, { hook_event_name: "SessionStart", session_id: SESSION, cwd: folder, source: "startup" }, folder);
    if (start.code !== 0) return failure(start);
    await writeFile(join(folder, FILE), PLANTED); // the edit is made: the hook runs after it
    const edit = await runHook(args, editInput(agent, folder), folder);
    if (/secret/i.test(told(edit.stdout))) return { ok: true, text: "A test edit with a planted secret went through Attentry's hook, and Attentry caught it." };
    return failure(edit);
  } finally {
    await stopBackground(folder); // the hooks started one for the folder
    await rm(folder, { recursive: true, force: true });
  }
}
