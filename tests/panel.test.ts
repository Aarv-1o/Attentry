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

test("panel: the Tests section, under the findings, with untested routes, the last run and the switch", () => {
  const p = panel();
  p.send("findings", { data: { show: "changes", items: [] } });
  p.send("agent", { info: { claude: "connected", mode: "suggest", live: null } });
  const view = (last: object | null, suggestions = true) => ({ data: { suggestions, routes: 4, last,
    untested: [{ method: "DELETE", path: "/api/notes/:id", file: "src/notes.js", line: 9, open: true }, { method: "GET", path: "/api/tags", file: "src/tags.js", line: 3, open: false }] } });
  p.send("tests", view(null));
  const text = p.text();
  assert.match(text, /Tests 2 of 4 routes tested/);
  assert.ok(text.indexOf("Tests") < text.indexOf("Claude Code"), "under the findings, above the agents");
  assert.match(text, /Routes with no test 2 .* DELETE \/api\/notes\/:id notes\.js:9 GET \/api\/tags tags\.js:3/);
  assert.match(text, /Not run yet/);
  assert.match(p.html(), /data-act="runTests" ><i class="play"><\/i>Run all tests<\/button><button class="more" data-act="testMenu"/, "one button, its arrow the menu");
  assert.doesNotMatch(p.html(), /Full output/, "nothing ran yet");
  // The last choice from the menu: the button says what a click runs.
  const failed = { state: "failed", label: "money.js", seconds: 2, tail: ["✖ cents", "Expected 100"], scope: "Tests for money.js", at: Date.now() };
  p.send("tests", { ...view({ ...failed, failing: ["cents", "rounding", "a", "b"], failingAt: [{ name: "cents", file: "tests/money.test.js", line: 4 }, { name: "rounding" }, { name: "a" }] }, false), run: "Run tests for the open file" });
  assert.match(p.text(), /Tests for money\.js failed · 4 failing tests · 2s · just now Full output cents money\.test\.js:4 rounding a …and 1 more\./, "one line, then the failing tests; one file's run doesn't repeat the command");
  assert.match(p.html(), /data-open="tests\/money\.test\.js" data-line="4"/);
  assert.match(p.html(), /play"><\/i>Run tests for the open file/);
  assert.match(p.html(), /data-suggest="off" aria-selected="true" disabled/);
  p.send("tests", view(failed));
  assert.match(p.text(), /failed · 2s · just now Full output ✖ cents Expected 100/, "no names: the output's last lines");
  assert.match(p.html(), /play"><\/i>Run tests for the open file/, "the choice is kept");
  p.send("tests", view({ state: "passed", label: "npm test", seconds: 4, tail: [], scope: "All tests", at: Date.now() }));
  assert.match(p.text(), /All tests passed · npm test, 4s · just now Full output/);
  p.send("tests", view({ state: "none", label: "no test reaches it", seconds: 0, tail: [], scope: "Tests for package.json", at: Date.now() }));
  assert.match(p.text(), /Tests for package\.json: no test reaches it · just now(?! Full)/);
  p.send("testsRunning", {});
  assert.match(p.text(), /Running…/);
  assert.match(p.html(), /data-act="runTests" disabled/);
  p.send("tests", { data: { suggestions: true, routes: 0, untested: [], last: null } });
  assert.match(p.html(), /<span class="pill off"><i><\/i>No routes<\/span>/, "no routes isn't good news: grey");
  assert.match(p.html(), /title="When Claude writes a plan, Attentry names the tests it needs"/, "the switch's sentence is its tooltip");
});

test("panel: no style attributes, which the panel's CSP drops", () => {
  const p = panel();
  p.send("findings", { data: { show: "changes", items: [finding("security", 1), finding("cleanup", 2)] } });
  p.send("agent", { info: { claude: "connected", mode: "suggest", live: { edits: 3, files: 2, added: 0, lastEditAt: Date.now(), untilCheckIn: 7, checkInEvery: 10 } } });
  assert.match(p.html(), /class="ticks"/);
  assert.match(p.html(), /class="bar"/);
  assert.doesNotMatch(p.html(), /style="/);
});
