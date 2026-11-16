import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

// The panel's real page script, run with a small stand-in for the webview: it's sent what the
// extension sends, and what it draws is read back as text.
function panel() {
  const app = { innerHTML: "" };
  let onMessage: (e: { data: unknown }) => void = () => undefined;
  const context = {
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: { getElementById: (id: string) => (id === "app" ? app : null), addEventListener: () => undefined },
    window: { scrollY: 0, scrollTo: () => undefined, addEventListener: (type: string, fn: typeof onMessage) => type === "message" && (onMessage = fn) },
    Intl, Date,
  };
  vm.runInNewContext(readFileSync(join(import.meta.dirname, "../editors/vscode/media/sidebar.js"), "utf8"), context);
  return {
    send: (type: string, payload: object) => onMessage({ data: { type, ...payload } }),
    text: () => app.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    html: () => app.innerHTML,
  };
}

const finding = (part: string, n: number) => ({ id: `${part}${n}`, rule: "r", part, severity: "info", file: "a.js", line: n, title: "t" });

test("panel headline: clean-up is counted apart from problems", () => {
  const p = panel();
  const show = (...items: object[]) => (p.send("findings", { data: { show: "changes", items } }), p.text());
  assert.match(show(finding("cleanup", 1)), /No problems in your changes · 1 thing to clean up/);
  assert.match(show(finding("security", 1), finding("cleanup", 2), finding("cleanup", 3)), /1 problem in your changes · 2 things to clean up/);
  assert.match(show(finding("breaks", 1), finding("database", 2)), /2 problems in your changes(?! ·)/);
  assert.match(show(), /No problems in your changes(?! ·)/);
});

test("panel: Test connection under each agent that's connected", () => {
  const p = panel();
  const links = (info: object) => (p.send("agent", { info: { mode: "suggest", live: null, ...info } }), [...p.html().matchAll(/data-act="(test\w+)"/g)].map((m) => m[1]));
  assert.deepEqual(links({ claude: "connected", codex: "running" }), ["testClaude", "testCodex"]);
  assert.deepEqual(links({ claude: "unheard", codex: "approve" }), ["testClaude", "testCodex"], "most useful when the agent isn't heard from");
  assert.deepEqual(links({ claude: "missing", codex: "missing" }), [], "nothing to test before connecting");
  assert.deepEqual(links({ claude: "connected", codex: "absent" }), ["testClaude"]);
});
