import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { testConnection } from "../src/agent/connection.ts";
import { makeRepo } from "./helpers.ts";

// The hooks the agents run are the built Attentry: build it on a fresh clone.
const attentry = join(import.meta.dirname, "../dist/attentry.mjs");
const leftovers = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("attentry-test-")).length;

test("Test connection: a planted secret through each agent's hook is caught", { timeout: 120_000 }, async () => {
  if (!existsSync(attentry)) execFileSync(process.execPath, [join(import.meta.dirname, "../scripts/build.mjs")]);
  const before = await leftovers();
  for (const agent of ["claude", "codex"] as const) {
    const result = await testConnection(agent, [attentry, "hook", agent]);
    assert.deepEqual(result, { ok: true, text: "A test edit with a planted secret went through Attentry's hook, and Attentry caught it." }, agent);
  }
  assert.equal(await leftovers(), before, "the throwaway folders are gone");
  // The test ran the hooks, not the agent: the panel mustn't say the agent's sessions run them.
  for (const agent of ["claude", "codex"]) assert.equal(existsSync(join(homedir(), ".attentry", `${agent}.json`)), false, agent);
});

test("Test connection: a broken install or a silent hook says what's wrong", { timeout: 60_000 }, async () => {
  const missing = await testConnection("claude", [join(tmpdir(), "no-such-attentry.mjs"), "hook", "claude"]);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /^Attentry's hook failed: Error: Cannot find module/);

  const dir = await makeRepo({});
  await writeFile(join(dir, "silent.mjs"), "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
  assert.deepEqual(await testConnection("codex", [join(dir, "silent.mjs")]), { ok: false, text: "Attentry's hook ran, but didn't catch the planted secret." });
});
