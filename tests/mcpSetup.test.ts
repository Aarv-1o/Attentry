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

test("adds Attentry's MCP server with Claude Code's own command, in the project's folder", { skip: process.platform === "win32" }, async () => {
  const folder = await makeRepo({});
  const attentry = join(await makeRepo({ "attentry.mjs": "" }), "attentry.mjs");
  const claude = await fakeClaude();
  const path = process.env.PATH;
  process.env.PATH = `${claude.dir}:${path}`;
  try {
    assert.deepEqual(await addMcp(folder, attentry), { ok: true });
    assert.deepEqual(await claude.calls(), [
      `${folder}|mcp remove attentry --scope local`, // re-adding after an update moved Attentry
      `${folder}|mcp add attentry --scope local -- node ${attentry} mcp`,
    ]);
  } finally {
    process.env.PATH = path;
  }
  process.env.PATH = "/nonexistent";
  try {
    const missing = await addMcp(folder, attentry);
    assert.deepEqual(missing, { ok: false, reason: "Claude Code's `claude` command isn't installed", command: `claude mcp add attentry --scope local -- node "${attentry}" mcp` });
  } finally {
    process.env.PATH = path;
  }
});

test("mcpState: added, missing, or pointing at an Attentry that moved", async () => {
  const folder = await makeRepo({});
  const attentry = join(await makeRepo({ "attentry.mjs": "" }), "attentry.mjs");
  await withClaudeSettings({}, async () => assert.equal(await mcpState(folder), "missing"));
  const at = (path: string) => ({ projects: { [folder]: { mcpServers: { attentry: { command: "node", args: [path, "mcp"] } } } } });
  await withClaudeSettings(at(attentry), async () => assert.equal(await mcpState(folder), "added"));
  await withClaudeSettings(at("/old/attentry.attentry-0.0.9/dist/server.mjs"), async () => assert.equal(await mcpState(folder), "stale"));
});

test("mcpState: found under any spelling of the folder Claude Code keeps (d:/repo and D:/repo)", async () => {
  const project = await makeRepo({});
  const server = join(project, "attentry.mjs");
  await writeFile(server, "");
  const other = project.replace(/^./, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
  const projects = { [other]: { mcpServers: { "other-tool": { command: "node", args: ["old.mjs", "mcp"] } } }, [project]: { mcpServers: { attentry: { command: "node", args: [server, "mcp"] } } } };
  await withClaudeSettings({ projects }, async () => assert.equal(await mcpState(project), "added"));
});
