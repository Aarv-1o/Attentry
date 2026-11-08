import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseSource } from "../src/parse/parse.ts";
import { formatHotspots } from "../src/report/hotspots.ts";
import { findHotspots, gitHistory, indentComplexity, stringRows } from "../src/rules/codebase/hotspots.ts";
import { makeRepo } from "./helpers.ts";

test("complexity: total indentation in the file's own indent steps", () => {
  const two = "if (a) {\n  if (b) {\n    go();\n  }\n}\n";
  const four = "if (a) {\n    if (b) {\n        go();\n    }\n}\n";
  assert.deepEqual(indentComplexity(two), { lines: 5, complexity: 4 });
  assert.deepEqual(indentComplexity(four), indentComplexity(two));
  assert.deepEqual(indentComplexity("\tif (a) {\n\t\tgo();\n\t}\n"), { lines: 3, complexity: 4 });
});

test("complexity: text inside multi-line strings (prompts, templates) isn't code", async () => {
  const source = 'PROMPT = """\n    You are a helpful assistant.\n        Be brief.\n"""\ndef f():\n    return PROMPT\n';
  const tree = await parseSource(source, "python");
  try {
    assert.deepEqual(indentComplexity(source, stringRows(tree.rootNode)), { lines: 3, complexity: 1 });
  } finally {
    tree.delete();
  }
});

test("hotspots: complex AND often changed ranks first; files that rarely change are left out", () => {
  const sizes = new Map([
    ["big-stable.ts", { lines: 900, complexity: 3000 }],
    ["big-busy.ts", { lines: 800, complexity: 2500 }],
    ["small-busy.ts", { lines: 40, complexity: 30 }],
    ["once.ts", { lines: 2000, complexity: 9000 }],
  ]);
  const changes = new Map([["big-stable.ts", 3], ["big-busy.ts", 12], ["small-busy.ts", 15], ["once.ts", 1]]);
  assert.deepEqual(findHotspots(changes, sizes, 40).map((h) => h.file), ["big-busy.ts", "big-stable.ts", "small-busy.ts"]);
  // 2 changes in 55 commits isn't "often"; 3 of 100 isn't either (under 5%).
  assert.deepEqual(findHotspots(new Map([["a.ts", 2]]), new Map([["a.ts", { lines: 600, complexity: 900 }]]), 55), []);
  assert.deepEqual(findHotspots(new Map([["a.ts", 3]]), new Map([["a.ts", { lines: 600, complexity: 900 }]]), 100), []);
});

test("git history: counts changes per file, also when scanning a folder inside the repo", async () => {
  const root = await makeRepo({ "app/a.py": "x = 0\n", "app/b.py": "y = 0\n", "other.py": "z = 0\n" });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(root, "app/a.py"), `x = ${i}\n`);
    if (i % 3 === 0) writeFileSync(join(root, "other.py"), `z = ${i}\n`);
    git("add", "-A");
    git("commit", "-qm", `c${i}`);
  }
  const all = await gitHistory(root);
  assert.ok(all.ok);
  assert.equal(all.changes.get("app/a.py"), 10);
  assert.equal(all.changes.get("other.py"), 4);
  const inner = await gitHistory(join(root, "app"));
  assert.ok(inner.ok);
  assert.deepEqual([...inner.changes].sort(), [["a.py", 10], ["b.py", 1]]);
  assert.deepEqual(await gitHistory(await makeRepo({ "a.py": "" })), { ok: false, reason: "not a git repo" });
});

test("hotspots report: ranked, with findings per file; or why it wasn't checked", () => {
  const hotspots = findHotspots(
    new Map([["src/Inbox.tsx", 12], ["src/util.ts", 3]]),
    new Map([["src/Inbox.tsx", { lines: 2149, complexity: 14000 }], ["src/util.ts", { lines: 180, complexity: 90 }]]),
    47,
  );
  const text = formatHotspots({ ok: true, commits: 47, changes: new Map() }, hotspots, new Map([["src/Inbox.tsx", 19]]), false);
  assert.match(text, /^Hotspots: complex files that change often, where changes break things most \(from 47 commits\)/);
  assert.match(text, /1\. src\/Inbox\.tsx {2}12 changes {2}2,149 lines {2}19 findings above\n {2}2\. src\/util\.ts {5}3 changes {4}180 lines\n/);
  assert.equal(formatHotspots({ ok: false, reason: "only 3 commits of history" }, [], new Map(), false), "Hotspots: not checked (only 3 commits of history).\n");
  const small = findHotspots(new Map([["a.ts", 9]]), new Map([["a.ts", { lines: 60, complexity: 80 }]]), 20);
  assert.equal(formatHotspots({ ok: true, commits: 20, changes: new Map() }, small, new Map(), true), "No hotspots found (the files that change most are small and have no findings).\n");
});
