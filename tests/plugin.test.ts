import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { isEdit } from "../src/agent/hooks.ts";
import { allowTools, installPlugin, pluginHome, refreshPlugin, TOOLS_RULE } from "../src/agent/plugin.ts";
import { makeRepo } from "./helpers.ts";

// The Claude Code plugin the extension carries: its files name the build and the events, so they
// must agree with the code (Claude Code validates the format, `claude plugin validate`, not this).

const PLUGIN = join(import.meta.dirname, "../claude-plugin/attentry");
const read = async (file: string) => JSON.parse(await readFile(join(PLUGIN, file), "utf8"));
const RUN = ["${CLAUDE_PLUGIN_ROOT}/dist/attentry.mjs"];

test("plugin hooks: every event Attentry answers, on every edit tool and the plan, running the build inside the plugin", async () => {
  const { hooks } = await read("hooks/hooks.json");
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop"]);
  for (const [event, groups] of Object.entries(hooks) as [string, { matcher?: string; hooks: { command: string; args: string[] }[] }[]][]) {
    for (const group of groups) {
      for (const h of group.hooks) assert.deepEqual([h.command, ...h.args], ["node", ...RUN, "hook", "claude"], event);
      if (group.matcher === "ExitPlanMode") assert.equal(event, "PreToolUse", "notes on a plan come before Claude starts it");
      else if (event.endsWith("ToolUse")) {
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

// A stand-in for Claude Code's `claude` command (a .cmd on Windows): writes down each call, and
// answers `plugin list --json` with `listed`. Named by ATTENTRY_CLAUDE, so the real claude.exe on
// PATH is never the one run; and with its own CLAUDE_CONFIG_DIR, so even that couldn't touch the
// person's real Claude Code.
async function fakeClaude(listed: object[]) {
  const dir = await makeRepo({ "listed.json": JSON.stringify(listed) });
  const log = join(dir, "calls.log");
  await writeFile(join(dir, "fake.mjs"), [
    `import { appendFileSync, readFileSync } from "node:fs";`,
    `const args = process.argv.slice(2).join(" ");`,
    `appendFileSync(${JSON.stringify(log)}, args + "\\n");`,
    `if (args === "plugin list --json") process.stdout.write(readFileSync(${JSON.stringify(join(dir, "listed.json"))}, "utf8"));`,
  ].join("\n"));
  await writeFile(join(dir, "claude"), `#!/bin/sh\nexec node "${join(dir, "fake.mjs")}" "$@"\n`);
  await chmod(join(dir, "claude"), 0o755);
  await writeFile(join(dir, "claude.cmd"), `@node "%~dp0fake.mjs" %*\r\n`);
  const before = { ATTENTRY_CLAUDE: process.env.ATTENTRY_CLAUDE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.ATTENTRY_CLAUDE = join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "config");
  return {
    calls: async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean) : []),
    [Symbol.dispose]: () => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

// The extension's claude/ folder: a marketplace, the plugin, and Attentry built into it. Under a
// folder with a space, as a home folder can be: `claude` gets it quoted on Windows.
const extension = async (version: string) => join(await makeRepo({
  "my extensions/claude/.claude-plugin/marketplace.json": "{}",
  "my extensions/claude/attentry/.claude-plugin/plugin.json": JSON.stringify({ name: "attentry", version }),
  "my extensions/claude/attentry/dist/attentry.mjs": "",
}), "my extensions");

test("pluginHome: the marketplace when Attentry runs from the extension's plugin, nothing otherwise", async () => {
  const root = await extension("1.0.0");
  assert.equal(pluginHome(join(root, "claude/attentry/dist/attentry.mjs")), join(root, "claude"));
  assert.equal(pluginHome(join(root, "dist/attentry.mjs")), undefined);
});

test("Connect installs the plugin for every project and takes out the hooks and MCP server it replaces", async () => {
  const home = join(await extension("1.0.0"), "claude");
  const mine = { type: "command", command: "prettier --write" };
  const old = { type: "command", command: 'node "C:/old/dist/attentry.mjs" hook claude' };
  const folder = await makeRepo({ ".claude/settings.local.json": JSON.stringify({ model: "opus", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [mine, old] }], Stop: [{ hooks: [old] }] } }) });
  using claude = await fakeClaude([]);
  assert.deepEqual(await installPlugin(home, folder), { ok: true });
  assert.deepEqual(await claude.calls(), [
    `plugin marketplace add ${home}`, "plugin install attentry@attentry --scope user", "plugin enable attentry@attentry",
    "plugin update attentry@attentry", "mcp remove attentry --scope local",
  ]);
  const settings = JSON.parse(await readFile(join(folder, ".claude/settings.local.json"), "utf8"));
  assert.deepEqual(settings, { model: "opus", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [mine] }] } }, "the person's own hook stays");
  // Attentry's read-only tools are allowed in the person's Claude Code settings, once.
  const user = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
  assert.deepEqual(JSON.parse(await readFile(user, "utf8")), { permissions: { allow: [TOOLS_RULE] } });
});

test("allowing Attentry's tools keeps the person's settings, adds the rule once, and leaves a file it can't read alone", async () => {
  using _claude = await fakeClaude([]);
  const user = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
  await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  await writeFile(user, JSON.stringify({ theme: "dark", permissions: { allow: ["Bash(npm test)"], deny: ["Read(.env)"] } }));
  assert.equal(await allowTools(), true);
  assert.equal(await allowTools(), true);
  assert.deepEqual(JSON.parse(await readFile(user, "utf8")), { theme: "dark", permissions: { allow: ["Bash(npm test)", TOOLS_RULE], deny: ["Read(.env)"] } });
  await writeFile(user, "{ // a comment\n}");
  assert.equal(await allowTools(), false);
  assert.equal(await readFile(user, "utf8"), "{ // a comment\n}");
});

test("when the editor starts, an installed plugin older than the extension's is updated; nothing else is touched", async () => {
  const home = join(await extension("1.1.0"), "claude");
  const folder = await makeRepo({});
  {
    using claude = await fakeClaude([{ id: "attentry@attentry", enabled: true, version: "1.0.0" }]);
    await refreshPlugin(home, folder);
    assert.deepEqual(await claude.calls(), ["plugin list --json", `plugin marketplace add ${home}`, "plugin update attentry@attentry", "plugin list --json"]);
  }
  for (const listed of [[{ id: "attentry@attentry", enabled: true, version: "1.1.0" }], []]) {
    using claude = await fakeClaude(listed);
    assert.deepEqual(await refreshPlugin(home, folder), listed.length ? { installed: true, enabled: true, version: "1.1.0" } : { installed: false });
    assert.deepEqual(await claude.calls(), ["plugin list --json"], "up to date, or never installed: left alone");
  }
});
