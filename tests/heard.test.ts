import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { noteHeard, noteInstalled } from "../src/agent/heard.ts";
import { claudeHooks } from "../src/agent/plugin.ts";
import { withHome } from "./helpers.ts";

// A Claude Code session in `folder`, last active `at`: Claude Code's own file for it.
async function claudeSession(folder: string, at: number) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(dir, { recursive: true });
  const file = join(dir, "1b2c.jsonl");
  await writeFile(file, "{}\n");
  await utimes(file, new Date(at), new Date(at));
}

test("Claude Code's hooks: waiting until a session here, not running if one ran without them, running once heard", () => withHome({}, async (me) => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(me, ".claude");
  try {
    const project = join(me, "work", "my-app");
    assert.equal(await claudeHooks([project]), "waiting", "connected by an earlier Attentry: watched from now on");
    await noteInstalled("claude");
    await claudeSession(join(me, "elsewhere"), Date.now() + 1000);
    assert.equal(await claudeHooks([project]), "waiting", "a session in another folder isn't this project's");
    await claudeSession(project, Date.now() + 1000);
    assert.equal(await claudeHooks([project]), "unheard", "a session here, and no word from the hooks");
    await noteHeard("claude");
    assert.equal(await claudeHooks([project]), "running", "a hook ran: a session open since before connecting counts too");
    await noteInstalled("claude");
    assert.equal(await claudeHooks([project]), "unheard", "connected again: heard before that doesn't count");
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
}));
