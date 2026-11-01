import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { addMcp, mcpState } from "../src/agent/mcpSetup.ts";
import { makeRepo, withClaudeSettings } from "./helpers.ts";

// A stand-in for Claude Code's `claude` command that writes down how it was called.
async function fakeClaude(): Promise<{ dir: string; calls: () => Promise<string[]> }> {
  const dir = await makeRepo({});
  const log = join(dir, "calls.log");
  await writeFile(join(dir, "claude"), `#!/bin/sh\necho "$PWD|$*" >> "${log}"\n`);
  await chmod(join(dir, "claude"), 0o755);
  return { dir, calls: async () => (await readFile(log, "utf8")).trim().split("\n") };
}

test("adds Detron's MCP server with Claude Code's own command, in the project's folder", { skip: process.platform === "win32" }, async () => {
  const folder = await makeRepo({});
  const detron = join(await makeRepo({ "detron.mjs": "" }), "detron.mjs");
  const claude = await fakeClaude();
  const path = process.env.PATH;
  process.env.PATH = `${claude.dir}:${path}`;
  try {
    assert.deepEqual(await addMcp(folder, detron), { ok: true });
    assert.deepEqual(await claude.calls(), [
      `${folder}|mcp remove detron --scope local`, // re-adding after an update moved Detron
      `${folder}|mcp add detron --scope local -- node ${detron} mcp`,
    ]);
  } finally {
    process.env.PATH = path;
  }
  process.env.PATH = "/nonexistent";
  try {
    const missing = await addMcp(folder, detron);
    assert.deepEqual(missing, { ok: false, reason: "Claude Code's `claude` command isn't installed", command: `claude mcp add detron --scope local -- node "${detron}" mcp` });
  } finally {
    process.env.PATH = path;
  }
});

test("mcpState: added, missing, or pointing at a Detron that moved", async () => {
  const folder = await makeRepo({});
  const detron = join(await makeRepo({ "detron.mjs": "" }), "detron.mjs");
  await withClaudeSettings({}, async () => assert.equal(await mcpState(folder), "missing"));
  const at = (path: string) => ({ projects: { [folder]: { mcpServers: { detron: { command: "node", args: [path, "mcp"] } } } } });
  await withClaudeSettings(at(detron), async () => assert.equal(await mcpState(folder), "added"));
  await withClaudeSettings(at("/old/detron.detron-0.0.9/dist/server.mjs"), async () => assert.equal(await mcpState(folder), "stale"));
});
