import { basename } from "node:path";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

// The Tests section's run button: the main click runs the last choice again, its arrow opens a
// menu of what to run. A run's whole output goes to an Output channel; the panel shows a line.

type Choice = { kind: "all" } | { kind: "open" } | { kind: "changed" } | { kind: "test"; file: string };
type RunScope = { kind: "all" } | { kind: "changed" } | { kind: "files"; files: string[]; name: string };
interface TestChoices { command: string; open?: { file: string; tests: number }; changed?: number; files: string[] }

const tests = (n: number) => `${n} test file${n === 1 ? "" : "s"}`;
const openFile = () => vscode.window.activeTextEditor?.document.uri.fsPath;

export class TestRuns implements vscode.Disposable {
  private choice: Choice = { kind: "all" };
  private readonly output = vscode.window.createOutputChannel("Attentry tests");

  constructor(private readonly client: () => LanguageClient | undefined, private readonly running: () => void) {}

  // The main button's words: what a click runs.
  get label(): string {
    const c = this.choice;
    return c.kind === "all" ? "Run all tests" : c.kind === "open" ? "Run tests for the open file" : c.kind === "changed" ? "Run tests for changed files" : `Run ${basename(c.file)}`;
  }

  private choices(client: LanguageClient): Promise<TestChoices> {
    return client.sendRequest<TestChoices>("attentry/testChoices", { file: openFile() });
  }

  async menu(): Promise<void> {
    const client = this.client();
    if (!client) return;
    const c = await this.choices(client);
    const items: (vscode.QuickPickItem & { choice: Choice | "pick" })[] = [
      { label: "$(play) All tests", description: c.command || "no test command found", choice: { kind: "all" } },
      { label: `Tests for ${c.open ? basename(c.open.file) : "the open file"}`, description: c.open ? tests(c.open.tests) : "open a file in the project first", choice: { kind: "open" } },
      { label: "Tests for changed files", description: c.changed === undefined ? "not a git repo" : `${tests(c.changed)}, from git`, choice: { kind: "changed" } },
      { label: "Choose a test file…", description: tests(c.files.length), choice: "pick" },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: "Attentry: run which tests?" });
    if (!picked) return;
    let choice = picked.choice;
    if (choice === "pick") {
      const file = await vscode.window.showQuickPick(c.files, { title: "Attentry: run which test file?" });
      if (!file) return;
      choice = { kind: "test", file };
    }
    this.choice = choice;
    await this.run();
  }

  // The last choice, again. False when there was nothing to run (no open file).
  async run(): Promise<boolean> {
    const client = this.client();
    if (!client) return false;
    const scope = await this.scope(client);
    if (!scope) return false;
    this.running();
    const run = await client.sendRequest<{ output?: string; scope: string }>("workspace/executeCommand", { command: "attentry.server.runTests", arguments: [scope] });
    this.output.clear();
    this.output.append(run.output ?? `${run.scope}: nothing ran.`);
    return true;
  }

  private async scope(client: LanguageClient): Promise<RunScope | undefined> {
    const c = this.choice;
    if (c.kind === "all" || c.kind === "changed") return c;
    if (c.kind === "test") return { kind: "files", files: [c.file], name: basename(c.file) };
    const open = (await this.choices(client)).open;
    if (!open) return void vscode.window.showInformationMessage("Attentry: open a file in the project first, then run its tests.");
    return { kind: "files", files: [open.file], name: `Tests for ${basename(open.file)}` };
  }

  showOutput(): void {
    this.output.show(true);
  }

  dispose(): void {
    this.output.dispose();
  }
}
