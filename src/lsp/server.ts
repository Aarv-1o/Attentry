import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConnection, ProposedFeatures, TextDocumentSyncKind, type Connection } from "vscode-languageserver/node";
import { codexHome, codexHooks, codexUsed, installCodex, refreshCodex, type CodexState } from "../agent/codex.ts";
import { loadConfig, writeMode } from "../agent/config.ts";
import { allowCurrentTests, hookState, init } from "../agent/init.ts";
import { addMcp, mcpState } from "../agent/mcpSetup.ts";
import { installPlugin, pluginHome, refreshPlugin, type PluginState } from "../agent/plugin.ts";
import { agentStatus, repoFindings } from "../daemon/client.ts";
import { collectFindings } from "../findings/collect.ts";
import { markNotUseful } from "../findings/feedback.ts";
import { PARTS, partOf, severityOf, type Part } from "../findings/severity.ts";
import type { Finding } from "../findings/types.ts";
import { formatAgent } from "../report/agent.ts";
import { formatForPerson } from "../report/brief.ts";
import { formatMarkdown } from "../report/markdown.ts";
import { explainFindings, findingsOn } from "../report/explain.ts";
import { changedLines, isInChanges, type Changes } from "../scan/changes.ts";
import type { FileCache } from "../index/fileScan.ts";
import { scanRepo } from "../scan/scan.ts";
import { projectRoot } from "../index/project.ts";
import { codeActions, diagnosticsByFile, hotspotLens, hoverCard, uriOf } from "./convert.ts";

// `attentry lsp`: Attentry as a language server, so every editor that speaks LSP (VS Code, Cursor,
// Windsurf, Antigravity, JetBrains, Zed, Neovim) shows findings where the code is. The findings
// come from the repo's background Attentry, the one agents use: the repo is read once, and the
// editor and the agent see the same findings. Asked when the folder opens and after each save.

export interface Options {
  show: "changes" | "all"; // "changes": only what this branch or uncommitted work added
  hints: boolean;
  clientCommands: boolean; // the Attentry extension handles attentry.copyFix
  autoScan: boolean; // check again when files change; off: only when asked
}

export interface Status {
  scanning: boolean;
  show: Options["show"];
  counts: Record<Part, number>;
  older: number; // findings left out because they're from before your changes
  autoScan: boolean;
  lastScanAt: number; // 0 before the first scan
  reading?: string; // the first read of the repo, so far: "40% of 9,000 files, about 1 min left"
  error?: string;
}

const SAVE_DELAY_MS = 400; // several files saved at once: one scan
const READING_POLL_MS = 2_000; // while the background Attentry reads the repo, asked again this often

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return ""; // deleted since the scan: its squiggles go at the top until the next scan clears them
  }
}

export function startServer(connection: Connection): void {
  let workspace = ""; // the folder the editor opened: where Claude Code starts, so its hooks go here
  let root = ""; // the project in it, which Attentry scans
  let rootUri = "";
  let options: Options = { show: "changes", hints: false, clientCommands: false, autoScan: true };
  let lastScanAt = 0;
  let all: Finding[] = [];
  const files: FileCache = new Map(); // only when no background Attentry can start: then this one reads
  let changes: Changes = { ok: false, reason: "not scanned yet" };
  let published = new Set<string>();
  let texts = new Map<string, string[]>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  // The Claude Code plugin this extension carries, and whether it's installed (asked of Claude Code
  // when the editor starts and after Connect: each answer runs `claude`, too slow for every look).
  const home = pluginHome(process.argv[1]!);
  let plugin: Promise<PluginState | undefined> = Promise.resolve(undefined);
  const askPlugin = (ask: () => Promise<PluginState>) => (plugin = ask().catch(() => undefined)); // no `claude`: as if not installed
  // The same for Codex, from the codex/ marketplace beside it: asked only of someone who uses Codex.
  const codexAt = home && codexHome(home);
  let codexPlugin: Promise<CodexState | undefined> = Promise.resolve(undefined);
  const askCodex = (ask: () => Promise<CodexState>) => (codexPlugin = ask().catch(() => undefined)); // no `codex`: as if not installed

  const shown = () => all.filter((f) => (options.hints || f.confidence !== "maybe") && (options.show === "all" || isInChanges(f, changes)));
  // Findings left out because they're from before your changes.
  const older = () => (options.show === "changes" ? all.filter((f) => !isInChanges(f, changes)).length : 0);
  const fileOf = (uri: string) => relative(root, fileURLToPath(uri)).replace(/\\/g, "/");
  const linesOf = (file: string) => texts.get(file) ?? [];

  function status(scanning: boolean, more: { error?: string; reading?: string } = {}): void {
    const now = shown().filter((f) => severityOf(f) !== "hint" && f.rule !== "hotspot");
    const counts = Object.fromEntries(PARTS.map((p) => [p, now.filter((f) => partOf(f) === p).length])) as Record<Part, number>;
    void connection.sendNotification("attentry/status", { scanning, show: options.show, counts, older: older(), autoScan: options.autoScan, lastScanAt, ...more } satisfies Status);
  }

  async function publish(): Promise<void> {
    const list = shown();
    const files = [...new Set(list.map((f) => f.file))];
    texts = new Map(await Promise.all(files.map(async (f) => [f, (await readOrEmpty(join(root, f))).split("\n")] as const)));
    const byFile = diagnosticsByFile(rootUri, list, linesOf);
    const now = new Set<string>();
    for (const [file, diagnostics] of byFile) {
      const uri = uriOf(rootUri, file);
      now.add(uri);
      await connection.sendDiagnostics({ uri, diagnostics });
    }
    for (const uri of published) if (!now.has(uri)) await connection.sendDiagnostics({ uri, diagnostics: [] });
    published = now;
    status(false);
  }

  async function scan(): Promise<void> {
    status(true);
    try {
      const found = await repoFindings(root, async () => collectFindings(await scanRepo(root, files)));
      if (!Array.isArray(found)) {
        status(true, found);
        clearTimeout(timer);
        timer = setTimeout(() => void rescan(), READING_POLL_MS);
        return;
      }
      all = found;
      changes = await changedLines(root);
      lastScanAt = Date.now();
      await publish();
    } catch (error) {
      connection.console.error(`Attentry scan failed: ${(error as Error).stack ?? error}`);
      status(false, { error: (error as Error).message });
    }
  }

  // One scan at a time; a save during a scan runs one more after it.
  function rescan(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = scan().finally(() => {
      running = undefined;
      if (again) {
        again = false;
        void rescan();
      }
    });
    return running;
  }

  connection.onInitialize(async (params) => {
    const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    workspace = folder ? fileURLToPath(folder) : process.cwd();
    // The project may be one folder down (an unzipped repo): keep the editor's spelling of the
    // part it opened (Windows: file:///d%3A/...), and add the rest.
    root = await projectRoot(workspace);
    const below = relative(workspace, root).split(sep).filter(Boolean).map(encodeURIComponent);
    rootUri = [folder ?? pathToFileURL(workspace).href, ...below].join("/");
    options = { ...options, ...(params.initializationOptions as Partial<Options> | undefined) };
    return {
      capabilities: {
        textDocumentSync: { openClose: true, save: true, change: TextDocumentSyncKind.None },
        hoverProvider: true,
        codeActionProvider: true,
        codeLensProvider: {},
        // "attentry.server.*": the editor's language client registers each of these as an editor
        // command, so they mustn't share names with the extension's own attentry.* commands.
        executeCommandProvider: { commands: ["attentry.server.notUseful", "attentry.server.toggleShow", "attentry.server.set", "attentry.server.rescan", "attentry.server.connectAgent", "attentry.server.connectCodex", "attentry.server.allowTests", "attentry.server.setMode"] },
      },
      serverInfo: { name: "attentry" },
    };
  });
  connection.onInitialized(() => {
    void rescan();
    if (home) askPlugin(() => refreshPlugin(home, workspace)); // after an extension update: the agent's copy too
    if (codexAt && codexUsed()) askCodex(() => refreshCodex(codexAt, workspace));
  });
  // A save in the editor, or a file changed on disk (an agent's edit, a git checkout).
  const changed = () => {
    if (!options.autoScan) return;
    clearTimeout(timer);
    timer = setTimeout(() => void rescan(), SAVE_DELAY_MS);
  };
  connection.onDidSaveTextDocument(changed);
  connection.onDidChangeWatchedFiles(changed);

  connection.onHover(({ textDocument, position }) => {
    const here = findingsOn(shown(), fileOf(textDocument.uri), position.line + 1).filter((f) => f.rule !== "hotspot");
    return here.length ? { contents: hoverCard(here) } : null;
  });
  connection.onCodeAction(({ textDocument, range }) => {
    const file = fileOf(textDocument.uri);
    const here = shown().filter((f) => f.file === file && f.rule !== "hotspot" && f.line - 1 <= range.end.line && range.start.line <= (f.endLine ?? f.line) - 1);
    return codeActions(textDocument.uri, here, linesOf(file), { clientCommands: options.clientCommands, explain: (f) => explainFindings(root, [f]) });
  });
  connection.onCodeLens(({ textDocument }) => shown().filter((f) => f.rule === "hotspot" && f.file === fileOf(textDocument.uri)).map(hotspotLens));
  connection.onExecuteCommand(async ({ command, arguments: args }) => {
    if (command === "attentry.server.notUseful") {
      const [id, rule] = args as [string, string];
      await markNotUseful(root, { id, rule });
      all = all.filter((f) => f.id !== id);
      return rescan();
    }
    if (command === "attentry.server.toggleShow") {
      options.show = options.show === "changes" ? "all" : "changes";
      return publish();
    }
    // The editor's settings changed: hints, automatic checks.
    if (command === "attentry.server.set") {
      const set = (args?.[0] ?? {}) as { hints?: boolean; autoScan?: boolean };
      const catchUp = set.autoScan === true && !options.autoScan; // what changed while it was off
      if (typeof set.hints === "boolean") options.hints = set.hints;
      if (typeof set.autoScan === "boolean") options.autoScan = set.autoScan;
      return catchUp ? rescan() : publish();
    }
    if (command === "attentry.server.rescan") return rescan();
    // From the extension: install its plugin (hooks and MCP tools in one), and say how it went.
    // Run from anywhere else (Attentry's own source), there's no plugin: hooks in the folder, and
    // with `true` the MCP tools. init's own messages are for the terminal, not the editor.
    if (command === "attentry.server.connectAgent") {
      if (home) {
        const result = await installPlugin(home, workspace);
        if (result.ok) await allowCurrentTests(root); // as init does: connecting says yes to the tests
        await askPlugin(() => refreshPlugin(home, workspace));
        return result;
      }
      await init(workspace, process.argv[1]!, undefined);
      return args?.[0] === true ? addMcp(workspace, process.argv[1]!) : undefined;
    }
    // Codex has only the plugin: the extension carries it, Attentry's own source doesn't.
    if (command === "attentry.server.connectCodex") {
      if (!codexAt) return { ok: false, reason: "this copy of Attentry has no Codex plugin (run it from the editor extension)", command: "" };
      const result = await installCodex(codexAt, workspace);
      if (result.ok) await allowCurrentTests(root);
      await askCodex(() => refreshCodex(codexAt, workspace));
      return result;
    }
    // The person clicked Allow tests: the project's test commands as they are now.
    if (command === "attentry.server.allowTests") return (await allowCurrentTests(root)).map((t) => t.label);
    if (command === "attentry.server.setMode") return void (await writeMode(root, (args?.[0] === "block" ? "block" : "suggest")));
    return undefined;
  });

  // For the editor's sidebar: the list, a whole report, one finding's full explanation.
  connection.onRequest("attentry/findings", () => ({
    show: options.show, hints: options.hints, older: older(),
    // The project, when it's a folder inside the one the editor opened.
    ...(root !== workspace ? { project: relative(workspace, root).replace(/\\/g, "/") } : {}),
    // Why "your changes" is everything, if it is: "not a git repo", "no commits yet".
    ...(changes.ok ? {} : { noChanges: changes.reason }),
    items: shown().map((f) => ({ id: f.id, rule: f.rule, part: partOf(f), severity: severityOf(f), file: f.file, line: f.line, title: f.title, why: f.why, does: f.plain?.does, replacedBy: f.plain?.replacedBy })),
  }));
  // The agent: are Attentry's hooks set up, which mode, and how its task is going right now. The
  // plugin, when it's on, brings both the hooks and the MCP tools.
  connection.onRequest("attentry/agent", async () => {
    const on = await plugin.then((p) => p?.installed && p.enabled);
    const hooks = on ? "connected" : await hookState(workspace);
    const mcp = on ? "added" : await mcpState(workspace);
    const cx = await codexPlugin;
    return {
      // Left out ("absent") for someone who doesn't use Codex. Connected, its hooks are running,
      // waiting for a first session, or need the person to trust them ("approve").
      codex: cx?.installed ? (cx.enabled ? await codexHooks() : "off") : codexUsed() && codexAt ? "missing" : "absent",
      // One state for the panel: Reconnect fixes either part pointing at an old Attentry.
      claude: hooks === "stale" || mcp === "stale" ? "stale" : hooks === "connected" ? "connected" : "missing",
      hooks,
      mcp,
      mode: (await loadConfig(root)).mode,
      live: (await agentStatus(root)) ?? null,
    };
  });
  connection.onRequest("attentry/report", ({ format }: { format: "agent" | "person" | "markdown" }) => {
    if (format === "agent") return formatAgent(root, shown(), options.hints);
    // Opened in a preview that has no file of its own: links name each file in full.
    if (format === "markdown") return formatMarkdown(shown(), { root, showHints: options.hints, older: older(), linkBase: `${pathToFileURL(root).href}/` });
    return formatForPerson(shown(), older());
  });
  connection.onRequest("attentry/explain", ({ id }: { id: string }) => {
    const f = all.find((x) => x.id === id);
    return f ? explainFindings(root, [f]) : "";
  });
  connection.listen();
}

export function runLanguageServer(): void {
  startServer(createConnection(ProposedFeatures.all, process.stdin, process.stdout));
}
