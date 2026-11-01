import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { doctor } from "../src/agent/doctor.ts";
import { makeRepo } from "./helpers.ts";

// Claude Code's own settings file, in a home folder of the test's.
async function withHome(claude: object, run: () => Promise<void>) {
  const home = await makeRepo({ ".claude.json": JSON.stringify(claude) });
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    await run();
  } finally {
    process.env.HOME = before;
  }
}

test("doctor: the project, git, hooks, mode and MCP, with what to do", async () => {
  const folder = await makeRepo({ "shop/README.md": "", "shop/src/app.ts": "export const a = 1;\n" });
  const project = join(folder, "shop");
  await withHome({}, async () => {
    const report = await doctor(folder);
    assert.match(report, /^✓ Project: shop, inside the folder you're in \(1 files Detron reads\)\n! Git: no/);
    assert.match(report, /✗ Claude Code hooks: not set up in this folder\n {2}→ Run `detron init` here/);
    assert.match(report, /! MCP tools \(find_existing, check, explain\): not added/);
  });
  // `claude mcp add --scope local` from the project's folder, pointing at a Detron that exists.
  const detron = join(await makeRepo({}), "detron.mjs");
  await writeFile(detron, "");
  await withHome({ projects: { [project]: { mcpServers: { detron: { command: "node", args: [detron, "mcp"] } } } } }, async () => {
    assert.match(await doctor(folder), /✓ MCP tools: added \(Claude Code, for .+shop\)/);
  });
  await withHome({ mcpServers: { detron: { command: "node", args: [join(project, "moved/detron.mjs"), "mcp"] } } }, async () => {
    assert.match(await doctor(project), /✗ MCP tools: added \(Claude Code, for every folder\), but .+moved\/detron\.mjs isn't there/);
  });
  await mkdir(join(project, ".git"));
  await withHome({}, async () => assert.match(await doctor(project), /✓ Git: yes/));
});
