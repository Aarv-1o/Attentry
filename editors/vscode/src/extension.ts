import { join } from "node:path";
import * as vscode from "vscode";
import { LanguageClient, State, TransportKind, type ServerOptions } from "vscode-languageclient/node";
import { Sidebar, type Status } from "./sidebar.ts";

// The Detron extension for VS Code and its forks (Cursor, Windsurf, Antigravity): starts the
// Detron language server, which does all the work, and adds what LSP can't: the status bar,
// the sidebar, copying a fix to the clipboard, and the settings.

let client: LanguageClient | undefined;

function serverOptions(context: vscode.ExtensionContext): ServerOptions {
  const own = vscode.workspace.getConfiguration("detron").get<string[]>("serverCommand", []);
  if (own.length) return { command: own[0]!, args: own.slice(1), transport: TransportKind.stdio };
  const dist = context.asAbsolutePath("dist");
  return { module: join(dist, "server.mjs"), args: ["lsp"], transport: TransportKind.stdio };
}

function statusText(s: Status): [string, string] {
  if (s.error) return ["$(error) Detron: scan failed", s.error];
  if (s.reading) return ["$(sync~spin) Detron: reading the repo…", `Detron is reading the repo before its first check: ${s.reading}.`];
  if (s.scanning) return ["$(sync~spin) Detron: checking…", "Detron is checking the code."];
  const { security, breaks, database, cleanup } = s.counts;
  const parts = [security && `${security} security`, breaks && `${breaks} will break`, database && `${database} database`, cleanup && `${cleanup} clean-up`].filter(Boolean);
  const where = s.show === "changes" ? "in your changes" : "in the repo";
  const text = parts.length ? `$(shield) Detron: ${parts.join(" · ")}` : `$(check) Detron: nothing ${where}`;
  const older = s.show === "changes" && s.older ? ` ${s.older} older finding${s.older === 1 ? "" : "s"} from before your changes are hidden.` : "";
  return [text, `Showing ${where}.${older} Click to show ${s.show === "changes" ? "the whole repo" : "only your changes"}.`];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settings = vscode.workspace.getConfiguration("detron");
  client = new LanguageClient("detron", "Detron", serverOptions(context), {
    documentSelector: [{ scheme: "file" }],
    initializationOptions: { show: settings.get("show"), hints: settings.get("hints"), autoScan: settings.get("autoScan", true), clientCommands: true },
    // Files changed on disk too (an agent's edits, a checkout), not only saves in the editor.
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{js,jsx,ts,tsx,mjs,cjs,py,astro,prisma,sql,json}") },
  });

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = "detron.toggleShow";
  bar.text = "$(sync~spin) Detron";
  bar.show();
  const run = (command: string) => client?.sendRequest("workspace/executeCommand", { command, arguments: [] });
  context.subscriptions.push(
    bar,
    vscode.commands.registerCommand("detron.copyFix", async (text: string) => {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage("Detron: copied. Paste it into your agent's chat.");
    }),
    vscode.commands.registerCommand("detron.toggleShow", () => run("detron.server.toggleShow")),
    vscode.commands.registerCommand("detron.toggleHints", () => run("detron.server.toggleHints")),
    vscode.commands.registerCommand("detron.rescan", () => run("detron.server.rescan")),
  );
  const sidebar = new Sidebar(context.extensionUri, () => client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("detron.panel", sidebar),
    vscode.commands.registerCommand("detron.openReport", () => sidebar.run("openReport")),
    vscode.commands.registerCommand("detron.copyReport", () => sidebar.run("copyReport")),
  );
  client.onNotification("detron/status", (s: Status) => {
    [bar.text, bar.tooltip] = statusText(s);
    void sidebar.update(s);
  });
  client.onDidChangeState(({ newState }) => {
    if (newState === State.Stopped) [bar.text, bar.tooltip] = ["$(error) Detron: stopped", "The Detron server stopped. See View → Output → Detron for why."];
  });
  try {
    await client.start();
  } catch (error) {
    [bar.text, bar.tooltip] = ["$(error) Detron: couldn't start", `${(error as Error).message}\nSee View → Output → Detron.`];
    throw error; // VS Code logs it with the extension's name
  }
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop();
}
