import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

// The Detron panel in the activity bar, in three parts: findings (by part, each opens its line),
// scanning (scan now, automatic checks on or off, the agent's next check-in), and the agent
// (connect Claude Code and its MCP tools, suggest or block, how its task is going).

export interface Status {
  scanning: boolean;
  show: "changes" | "all";
  counts: { security: number; breaks: number; database: number; cleanup: number };
  older: number;
  autoScan: boolean;
  lastScanAt: number;
  reading?: string; // the first read of the repo, so far
  error?: string;
}

type McpResult = { ok: true } | { ok: false; reason: string; command: string };

const AGENT_POLL_MS = 4000; // the agent edits files on its own: refresh what it's doing

type FromPanel =
  | { type: "ready" | "rescan" | "toggleShow" | "toggleHints" | "toggleAuto" | "connectMcp" | "copyReport" | "openReport" | "settings" }
  | { type: "connectAgent"; withMcp?: boolean }
  | { type: "setMode"; mode: "suggest" | "block" }
  | { type: "open"; file: string; line: number }
  | { type: "copyFix"; id: string };

export class Sidebar implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private status: Status | undefined;

  constructor(private readonly extension: vscode.Uri, private readonly client: () => LanguageClient | undefined) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extension, "media")] };
    // Unguessable, or a script injected into the page could carry it (Math.random() can be predicted).
    const nonce = randomBytes(16).toString("base64");
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extension, "media", "sidebar.js"));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extension, "media", "sidebar.css"));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: FromPanel) => this.handle(m));
    const poll = setInterval(() => void (view.visible && this.agent()), AGENT_POLL_MS);
    view.onDidDispose(() => clearInterval(poll));
  }

  private async agent(): Promise<void> {
    const info = await this.client()?.sendRequest("detron/agent", {});
    if (info) void this.view?.webview.postMessage({ type: "agent", info });
  }

  async update(status: Status): Promise<void> {
    this.status = status;
    if (!this.view) return;
    void this.view.webview.postMessage({ type: "status", status });
    if (!status.scanning && !status.error) void this.view.webview.postMessage({ type: "findings", data: await this.client()?.sendRequest("detron/findings", {}) });
    await this.agent();
  }

  // Without Claude Code's command the person runs it: offer to copy it.
  private async mcpFailed(what: string, mcp: Extract<McpResult, { ok: false }>): Promise<void> {
    const copy = "Copy the command";
    if ((await vscode.window.showWarningMessage(`Detron: ${what}: ${mcp.reason}. Run this in the project's folder instead.`, copy)) === copy) {
      await vscode.env.clipboard.writeText(mcp.command);
    }
  }

  // The panel's title-bar buttons run these too.
  readonly run = (type: FromPanel["type"]) => this.handle({ type } as FromPanel);

  private async handle(m: FromPanel): Promise<void> {
    const client = this.client();
    if (!client) return;
    const command = (name: string) => client.sendRequest("workspace/executeCommand", { command: name, arguments: [] });
    if (m.type === "ready" && this.status) return this.update(this.status);
    if (m.type === "rescan") await command("detron.server.rescan");
    if (m.type === "toggleShow") await command("detron.server.toggleShow");
    if (m.type === "toggleHints") await command("detron.server.toggleHints");
    if (m.type === "toggleAuto") await command("detron.server.toggleAuto");
    if (m.type === "setMode") {
      await client.sendRequest("workspace/executeCommand", { command: "detron.server.setMode", arguments: [m.mode] });
      await this.agent();
    }
    if (m.type === "connectAgent") {
      try {
        const mcp = await client.sendRequest<McpResult | null>("workspace/executeCommand", { command: "detron.server.connectAgent", arguments: [!!m.withMcp] });
        if (mcp && !mcp.ok) await this.mcpFailed("Claude Code is connected, but its MCP tools couldn't be added", mcp);
        else void vscode.window.showInformationMessage(`Detron: Claude Code is connected${mcp ? ", with its MCP tools" : ""}. Start a new Claude Code session in this folder to use ${mcp ? "them" : "it"}.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Detron: couldn't connect Claude Code. ${(error as Error).message}`);
      }
      await this.agent();
    }
    if (m.type === "connectMcp") {
      const mcp = await command("detron.server.connectMcp") as McpResult;
      if (mcp.ok) void vscode.window.showInformationMessage("Detron: MCP tools added. Start a new Claude Code session in this folder to see them.");
      else await this.mcpFailed("Couldn't add the MCP tools", mcp);
      await this.agent();
    }
    if (m.type === "settings") await vscode.commands.executeCommand("workbench.action.openSettings", "detron");
    if (m.type === "open") {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, m.file));
      const at = new vscode.Position(m.line - 1, 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });
    }
    if (m.type === "copyFix") {
      await vscode.env.clipboard.writeText(await client.sendRequest<string>("detron/explain", { id: m.id }));
      void vscode.window.showInformationMessage("Detron: fix copied. Paste it into your agent's chat.");
    }
    if (m.type === "copyReport") {
      await vscode.env.clipboard.writeText(await client.sendRequest<string>("detron/report", { format: "agent" }));
      void vscode.window.showInformationMessage("Detron: report copied. Paste it into your agent's chat.");
    }
    if (m.type === "openReport") {
      // Rendered, not as source: a summary table, each finding a link to its line.
      const content = await client.sendRequest<string>("detron/report", { format: "markdown" });
      const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
      await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
    }
  }
}
