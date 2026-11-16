import { resolve } from "node:path";
import { forgetExtension } from "../../../src/agent/codex.ts";

// VS Code runs this once Attentry is uninstalled, at its next start ("vscode:uninstall"), from the
// extension's own folder. Codex may still be running this extension's Attentry: disconnect it.
void forgetExtension(resolve(__dirname, ".."));
