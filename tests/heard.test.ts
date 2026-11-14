import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { noteHeard, noteInstalled } from "../src/agent/heard.ts";
import { claudeHooks } from "../src/agent/plugin.ts";
import { withHome } from "./helpers.ts";

// A Claude Code session started now in `folder`: Claude Code's own file for it.
async function claudeSession(folder: string, name: string) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.jsonl`), "{}\n");
}

// Connected a few seconds ago: the sessions the test starts are after it.
const connectedAgo = (home: string) => writeFile(join(home, ".attentry", "claude.json"), JSON.stringify({ installedAt: Date.now() - 5000 }));

test("Claude Code's hooks: waiting until a session starts here, not running if one ran without them, running once heard", () => withHome({}, async (me) => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(me, ".claude");
  try {
    const project = join(me, "work", "my-app");
    assert.equal(await claudeHooks([project]), "waiting", "connected by an earlier Attentry: watched from now on");
    await connectedAgo(me);
    await claudeSession(join(me, "elsewhere"), "a");
    assert.equal(await claudeHooks([project]), "waiting", "a session in another folder isn't this project's");
    await claudeSession(project, "b");
    assert.equal(await claudeHooks([project]), "unheard", "a session started here since, and no word from the hooks");
    await noteHeard("claude");
    assert.equal(await claudeHooks([project]), "running");
    await new Promise((wait) => setTimeout(wait, 20));
    await noteInstalled("claude");
    assert.equal(await claudeHooks([project]), "waiting", "connected again (an update): a session open since before runs the old hooks, so it doesn't count");
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
}));
