import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { isEdit } from "../src/agent/hooks.ts";

// The Claude Code plugin the extension carries: its files name the build and the events, so they
// must agree with the code (Claude Code validates the format, `claude plugin validate`, not this).

const PLUGIN = join(import.meta.dirname, "../claude-plugin/attentry");
const read = async (file: string) => JSON.parse(await readFile(join(PLUGIN, file), "utf8"));
const RUN = ["${CLAUDE_PLUGIN_ROOT}/dist/attentry.mjs"];

test("plugin hooks: every event Attentry answers, on every edit tool, running the build inside the plugin", async () => {
  const { hooks } = await read("hooks/hooks.json");
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop"]);
  for (const [event, groups] of Object.entries(hooks) as [string, { matcher?: string; hooks: { command: string; args: string[] }[] }[]][]) {
    for (const group of groups) {
      for (const h of group.hooks) assert.deepEqual([h.command, ...h.args], ["node", ...RUN, "hook", "claude"], event);
      if (event.endsWith("ToolUse")) {
        const tools = group.matcher!.split("|");
        assert.ok(tools.every((tool_name) => isEdit({ hook_event_name: event, session_id: "", tool_name })), `${event}: ${group.matcher}`);
        assert.equal(tools.length, 4, "every edit tool Attentry checks");
      }
    }
  }
});

test("plugin MCP server: the same build, as `attentry`", async () => {
  assert.deepEqual((await read(".mcp.json")).mcpServers.attentry, { command: "node", args: [...RUN, "mcp"] });
});
