import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFile } from "atomically";

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
  testSuggestions: boolean; // the tests a plan needs, in the plan message and on the change card
}

const DEFAULTS: Config = { mode: "suggest", checkInEvery: 10, tests: undefined, testTimeoutSeconds: 300, testSuggestions: true };

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
    testSuggestions: read.testSuggestions !== false,
  };
}

// Changes settings the panel and `attentry init` set, keeping the rest of the file.
export async function writeConfig(root: string, change: Partial<Pick<Config, "mode" | "testSuggestions">>): Promise<string> {
  const path = join(root, ".attentry/config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // unreadable: don't overwrite
  }
  await writeFile(path, `${JSON.stringify({ ...config, ...change }, null, 2)}\n`);
  return path;
}
