import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Installed isn't running: Codex runs a plugin's hooks only once the person trusts them, and Claude
// Code's can fail to run (hooks turned off, no `node` on its PATH). So Attentry notes when it
// connected an agent and when the agent last ran one of its hooks (~/.attentry/<agent>.json).
// Heard from since connecting: running. An agent session since then without a word: not running.

export type Agent = "claude" | "codex";
type Heard = { installedAt?: number; heardAt?: number };

const heardFile = (agent: Agent) => join(homedir(), ".attentry", `${agent}.json`);

async function readHeard(agent: Agent): Promise<Heard> {
  try {
    return JSON.parse(await readFile(heardFile(agent), "utf8")) as Heard;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; // never connected or heard from
    throw error;
  }
}

async function note(agent: Agent, change: Heard): Promise<void> {
  const now = await readHeard(agent);
  await mkdir(dirname(heardFile(agent)), { recursive: true });
  await writeFile(heardFile(agent), `${JSON.stringify({ ...now, ...change })}\n`);
}

export const noteInstalled = (agent: Agent) => note(agent, { installedAt: Date.now() });

// From every hook, so a session that was open before connecting counts once it runs one. Written
// only until it's heard after the latest connect: most hooks only read the file.
export async function noteHeard(agent: Agent): Promise<void> {
  const { installedAt = 0, heardAt = 0 } = await readHeard(agent);
  if (!heardAt || heardAt < installedAt) await note(agent, { heardAt: Date.now() });
}

// "running": the agent runs the hooks. "waiting": no session since connecting yet. "unheard":
// sessions ran without them. `lastSession`: when the agent's newest session was last active.
// Connected before Attentry noted it (an earlier version): watched from now on.
export type HooksHeard = "running" | "waiting" | "unheard";
export async function hooksHeard(agent: Agent, lastSession: () => Promise<number>): Promise<HooksHeard> {
  const { installedAt, heardAt = 0 } = await readHeard(agent);
  if (installedAt === undefined) {
    if (heardAt) return "running";
    await noteInstalled(agent);
    return "waiting";
  }
  if (heardAt >= installedAt) return "running";
  return (await lastSession()) > installedAt ? "unheard" : "waiting";
}
