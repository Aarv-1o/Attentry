import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { TestCommand } from "./tests.ts";

// Running a repo's tests runs whatever the repo says: its test script, or "tests" in
// .detron/config.json. A cloned repo could say anything. So Detron runs them only once the person
// has connected Detron to the repo (`detron init`, or Connect in the sidebar), and asks again when
// the commands change. What was allowed lives in the person's home folder, where no repo can write it.

const allowedFile = () => join(homedir(), ".detron", "allowed-tests.json");

const fingerprint = (root: string, commands: TestCommand[]) =>
  createHash("sha256").update(JSON.stringify(commands.map((c) => [relative(root, c.cwd), c.command, c.runs]))).digest("hex");

async function readAllowed(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(allowedFile(), "utf8")) as Record<string, string>;
  } catch {
    return {}; // nothing allowed yet
  }
}

export async function testsAllowed(root: string, commands: TestCommand[]): Promise<boolean> {
  return (await readAllowed())[realpathSync(root)] === fingerprint(root, commands);
}

export async function allowTests(root: string, commands: TestCommand[]): Promise<void> {
  const allowed = { ...(await readAllowed()), [realpathSync(root)]: fingerprint(root, commands) };
  await mkdir(dirname(allowedFile()), { recursive: true, mode: 0o700 });
  await writeFile(allowedFile(), `${JSON.stringify(allowed, null, 2)}\n`, { mode: 0o600 });
}
