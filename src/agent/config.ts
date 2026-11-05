import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// .attentry/config.json, written by the person (or `attentry init`): how strict hooks are, and the
// tests to run.

export interface Config {
  // suggest: tell the agent, never stop it. block: also stop a task from finishing while it
  // has added security or crash problems.
  mode: "suggest" | "block";
  checkInEvery: number; // edits between check-ins
  // The test command run at check-ins and at the end, or "off". Unset: Attentry finds it.
  tests: string | undefined;
  testTimeoutSeconds: number;
}

const DEFAULTS: Config = { mode: "suggest", checkInEvery: 10, tests: undefined, testTimeoutSeconds: 300 };

export async function loadConfig(root: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(join(root, ".attentry/config.json"), "utf8");
  } catch {
    return DEFAULTS; // no config file: the defaults
  }
  const read = JSON.parse(text) as Partial<Config>;
  return {
    mode: read.mode === "block" ? "block" : "suggest",
    checkInEvery: Number.isInteger(read.checkInEvery) && read.checkInEvery! > 0 ? read.checkInEvery! : DEFAULTS.checkInEvery,
    tests: typeof read.tests === "string" && read.tests.trim() ? read.tests.trim() : undefined,
    testTimeoutSeconds: Number.isInteger(read.testTimeoutSeconds) && read.testTimeoutSeconds! > 0 ? read.testTimeoutSeconds! : DEFAULTS.testTimeoutSeconds,
  };
}

// Changes the mode, keeping the rest of the file.
export async function writeMode(root: string, mode: Config["mode"]): Promise<string> {
  const path = join(root, ".attentry/config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // unreadable: don't overwrite
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...config, mode }, null, 2)}\n`);
  return path;
}
