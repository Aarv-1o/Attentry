import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

// The Attentry panel in the activity bar: the findings (by part, each opens its line), the agents
// (connect Claude Code or Codex, suggest or block, how a task is going), and one line on the last check. Hints and
// automatic checks are settings, not switches here.

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

// Attentry's site and its code.
const SITE = "https://attentry.js.org";
const REPO = "https://github.com/Aarv-1o/Attentry";
const AGENT_POLL_MS = 4000; // the agent edits files on its own: refresh what it's doing

type FromPanel =
  | { type: "ready" | "rescan" | "toggleShow" | "connectAgent" | "connectCodex" | "allowTests" | "copyReport" | "openReport" | "settings" | "openSite" | "share" | "openGithub" }
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
    const info = await this.client()?.sendRequest("attentry/agent", {});
    if (info) void this.view?.webview.postMessage({ type: "agent", info });
  }

  async update(status: Status): Promise<void> {
    this.status = status;
    if (!this.view) return;
    void this.view.webview.postMessage({ type: "status", status });
    if (!status.scanning && !status.error) void this.view.webview.postMessage({ type: "findings", data: await this.client()?.sendRequest("attentry/findings", {}) });
    await this.agent();
  }

  // Connects an agent through the language server, and says how it went. Without the agent's own
  // command the person runs it: offer to copy it.
  private async connect(client: LanguageClient, agent: string, command: string, args: unknown[], done: string): Promise<void> {
    try {
      const result = await client.sendRequest<McpResult | null>("workspace/executeCommand", { command, arguments: args });
      if (result && !result.ok) {
        const copy = "Copy the command";
        const asked = await vscode.window.showWarningMessage(`Attentry: couldn't connect ${agent}: ${result.reason}.${result.command ? " Run this in the project's folder instead." : ""}`, ...(result.command ? [copy] : []));
        if (asked === copy) await vscode.env.clipboard.writeText(result.command);
      } else void vscode.window.showInformationMessage(`Attentry: ${agent} is connected. ${done}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Attentry: couldn't connect ${agent}. ${(error as Error).message}`);
    }
    await this.agent();
  }

  // The panel's title-bar buttons run these too.
  readonly run = (type: FromPanel["type"]) => this.handle({ type } as FromPanel);

  private async handle(m: FromPanel): Promise<void> {
    const client = this.client();
    if (!client) return;
    const command = (name: string) => client.sendRequest("workspace/executeCommand", { command: name, arguments: [] });
    if (m.type === "ready" && this.status) return this.update(this.status);
    if (m.type === "rescan") await command("attentry.server.rescan");
    if (m.type === "toggleShow") await command("attentry.server.toggleShow");
    if (m.type === "setMode") {
      await client.sendRequest("workspace/executeCommand", { command: "attentry.server.setMode", arguments: [m.mode] });
      await this.agent();
    }
    // The plugin brings the hooks and the MCP tools together; from Attentry's source, `true` adds both too.
    if (m.type === "connectAgent") await this.connect(client, "Claude Code", "attentry.server.connectAgent", [true], "Start a new Claude Code session to use it.");
    // Codex asks the person to trust a plugin's hooks before it runs them.
    if (m.type === "connectCodex") await this.connect(client, "Codex", "attentry.server.connectCodex", [], "Start a new Codex session, and trust Attentry's hooks when Codex asks (or run /hooks).");
    if (m.type === "allowTests") {
      const allowed = await client.sendRequest<string[]>("workspace/executeCommand", { command: "attentry.server.allowTests", arguments: [] });
      void vscode.window.showInformationMessage(allowed.length ? `Attentry: it may run ${allowed.join(", ")} at check-ins now. If the command changes, it asks again.` : "Attentry: no test command found here.");
      await this.agent();
    }
    if (m.type === "settings") await vscode.commands.executeCommand("workbench.action.openSettings", "attentry");
    if (m.type === "openSite") await vscode.env.openExternal(vscode.Uri.parse(SITE));
    if (m.type === "openGithub") await vscode.env.openExternal(vscode.Uri.parse(REPO));
    if (m.type === "share") {
      // A message ready to paste into a chat, with the link: the friend lands on the site.
      await vscode.env.clipboard.writeText(`Attentry watches what your AI coding agent writes (security holes, copied and dead code) and tells it right away. Free for VS Code + Claude Code: ${SITE}`);
      const open = "Open the site";
      if ((await vscode.window.showInformationMessage("Attentry: a message with the link is copied. Paste it to a friend.", open)) === open) await vscode.env.openExternal(vscode.Uri.parse(SITE));
    }
    if (m.type === "open") {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, m.file));
      const at = new vscode.Position(m.line - 1, 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });
    }
    if (m.type === "copyFix") {
      await vscode.env.clipboard.writeText(await client.sendRequest<string>("attentry/explain", { id: m.id }));
      void vscode.window.showInformationMessage("Attentry: fix copied. Paste it into your agent's chat.");
    }
    if (m.type === "copyReport") {
      await vscode.env.clipboard.writeText(await client.sendRequest<string>("attentry/report", { format: "agent" }));
      void vscode.window.showInformationMessage("Attentry: report copied. Paste it into your agent's chat.");
    }
    if (m.type === "openReport") {
      // Rendered, not as source: a summary table, each finding a link to its line.
      const content = await client.sendRequest<string>("attentry/report", { format: "markdown" });
      const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
      await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
    }
  }
}
