import { join } from "node:path";
import * as vscode from "vscode";
import { LanguageClient, State, TransportKind, type ServerOptions } from "vscode-languageclient/node";
import { Sidebar, type Status } from "./sidebar.ts";

// The Attentry extension for VS Code and its forks (Cursor, Windsurf, Antigravity): starts the
// Attentry language server, which does all the work, and adds what LSP can't: the status bar,
// the sidebar, copying a fix to the clipboard, and the settings.

let client: LanguageClient | undefined;

function serverOptions(context: vscode.ExtensionContext): ServerOptions {
  const own = vscode.workspace.getConfiguration("attentry").get<string[]>("serverCommand", []);
  if (own.length) return { command: own[0]!, args: own.slice(1), transport: TransportKind.stdio };
  // The Attentry inside the Claude Code plugin this extension carries: the editor and the agent run one build.
  return { module: context.asAbsolutePath(join("claude", "attentry", "dist", "attentry.mjs")), args: ["lsp"], transport: TransportKind.stdio };
}

function statusText(s: Status): [string, string] {
  if (s.error) return ["$(error) Attentry: scan failed", s.error];
  if (s.reading) return ["$(sync~spin) Attentry: reading the repo…", `Attentry is reading the repo before its first check: ${s.reading}.`];
  if (s.scanning) return ["$(sync~spin) Attentry: checking…", "Attentry is checking the code."];
  const { security, breaks, database, cleanup } = s.counts;
  const parts = [security && `${security} security`, breaks && `${breaks} will break`, database && `${database} database`, cleanup && `${cleanup} clean-up`].filter(Boolean);
  const where = s.show === "changes" ? "in your changes" : "in the repo";
  const text = parts.length ? `$(shield) Attentry: ${parts.join(" · ")}` : `$(check) Attentry: nothing ${where}`;
  const older = s.show === "changes" && s.older ? ` ${s.older} older finding${s.older === 1 ? "" : "s"} from before your changes are hidden.` : "";
  return [text, `Showing ${where}.${older} Click to show ${s.show === "changes" ? "the whole repo" : "only your changes"}.`];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settings = () => vscode.workspace.getConfiguration("attentry");
  client = new LanguageClient("attentry", "Attentry", serverOptions(context), {
    documentSelector: [{ scheme: "file" }],
    initializationOptions: { show: settings().get("show"), hints: settings().get("hints"), autoScan: settings().get("autoScan", true), clientCommands: true },
    // Files changed on disk too (an agent's edits, a checkout), not only saves in the editor.
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{js,jsx,ts,tsx,mjs,cjs,py,astro,prisma,sql,json}") },
  });

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = "attentry.toggleShow";
  bar.text = "$(sync~spin) Attentry";
  bar.show();
  const run = (command: string) => client?.sendRequest("workspace/executeCommand", { command, arguments: [] });
  context.subscriptions.push(
    bar,
    vscode.commands.registerCommand("attentry.copyFix", async (text: string) => {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage("Attentry: copied. Paste it into your agent's chat.");
    }),
    vscode.commands.registerCommand("attentry.toggleShow", () => run("attentry.server.toggleShow")),
    // Hints and automatic checks are settings: the panel stays short, and the choice is kept.
    vscode.commands.registerCommand("attentry.toggleHints", () => settings().update("hints", !settings().get("hints"), vscode.ConfigurationTarget.Global)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("attentry.hints") || e.affectsConfiguration("attentry.autoScan")) {
        void client?.sendRequest("workspace/executeCommand", { command: "attentry.server.set", arguments: [{ hints: settings().get("hints"), autoScan: settings().get("autoScan", true) }] });
      }
    }),
    vscode.commands.registerCommand("attentry.rescan", () => run("attentry.server.rescan")),
  );
  const sidebar = new Sidebar(context.extensionUri, () => client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("attentry.panel", sidebar),
    vscode.commands.registerCommand("attentry.openReport", () => sidebar.run("openReport")),
    vscode.commands.registerCommand("attentry.copyReport", () => sidebar.run("copyReport")),
  );
  client.onNotification("attentry/status", (s: Status) => {
    [bar.text, bar.tooltip] = statusText(s);
    void sidebar.update(s);
  });
  client.onDidChangeState(({ newState }) => {
    if (newState === State.Stopped) [bar.text, bar.tooltip] = ["$(error) Attentry: stopped", "The Attentry server stopped. See View → Output → Attentry for why."];
  });
  try {
    await client.start();
  } catch (error) {
    [bar.text, bar.tooltip] = ["$(error) Attentry: couldn't start", `${(error as Error).message}\nSee View → Output → Attentry.`];
    throw error; // VS Code logs it with the extension's name
  }
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop();
}
