import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { backgroundRunning } from "../daemon/client.ts";
import { isSource, listRepoFiles, unsupportedCode } from "../index/files.ts";
import { projectRoot } from "../index/project.ts";
import { loadConfig } from "./config.ts";
import { hookState } from "./init.ts";
import { detronMcp, detronPath } from "./mcpSetup.ts";

// `detron doctor`: is Detron set up here, and working? One check per line, with what to do when
// it isn't. Agents can run it too, when asked "is Detron connected?".

type Check = { ok: boolean | "warn"; text: string; fix?: string };

export async function doctor(folder: string): Promise<string> {
  const root = await projectRoot(folder);
  const checks: Check[] = [];
  const files = await listRepoFiles(root);
  const code = files.filter(isSource).length;
  const skipped = [...unsupportedCode(files)].map(([ext, n]) => `${n} .${ext}`).join(", ");
  checks.push(root === folder
    ? { ok: code > 0, text: `Project: ${root} (${code} files Detron reads${skipped ? `; not read: ${skipped}` : ""})`, ...(code ? {} : { fix: "No JavaScript, TypeScript or Python here: open the project's own folder." }) }
    : { ok: true, text: `Project: ${relative(folder, root)}, inside the folder you're in (${code} files Detron reads)` });
  const git = existsSync(join(root, ".git"));
  checks.push(git
    ? { ok: true, text: "Git: yes, so \"your changes\" means what this branch or your uncommitted work changed" }
    : { ok: "warn", text: "Git: no, so Detron can't tell what changed, and \"your changes\" is everything", fix: "Run `git init` and commit once: then only new problems are reported." });

  const hooks = await hookState(folder);
  checks.push(hooks === "connected"
    ? { ok: true, text: "Claude Code hooks: set up, and the Detron they run is there" }
    : hooks === "stale"
      ? { ok: false, text: "Claude Code hooks: set up, but the Detron they run has moved (an extension update)", fix: "Run `detron init` again, or click Reconnect in the Detron sidebar." }
      : { ok: false, text: "Claude Code hooks: not set up in this folder", fix: "Run `detron init` here, or click Connect Claude Code in the Detron sidebar." });
  checks.push({ ok: true, text: `Mode: ${(await loadConfig(root)).mode}` });

  const mcp = await detronMcp(root === folder ? [folder] : [folder, root]);
  const mcpPath = mcp && detronPath(mcp.server);
  checks.push(!mcp
    ? { ok: "warn", text: "MCP tools (find_existing, check, explain): not added for Claude Code here", fix: "Run the `claude mcp add` line that `detron init` prints. Other agents: see the README." }
    : mcpPath && !existsSync(mcpPath)
      ? { ok: false, text: `MCP tools: added (${mcp.where}), but ${mcpPath} isn't there`, fix: "Add it again with the path to your Detron." }
      : { ok: true, text: `MCP tools: added (${mcp.where}). A Claude Code session started before that needs a restart to see them` });

  checks.push((await backgroundRunning(root))
    ? { ok: true, text: "Background Detron: running" }
    : { ok: true, text: "Background Detron: not running (it starts on the agent's first edit or tool call)" });

  const mark = (c: Check) => (c.ok === true ? "✓" : c.ok === "warn" ? "!" : "✗");
  return `${checks.map((c) => `${mark(c)} ${c.text}${c.fix ? `\n  → ${c.fix}` : ""}`).join("\n")}\n`;
}
