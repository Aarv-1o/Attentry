import assert from "node:assert/strict";
import { test } from "node:test";
import { collectFindings } from "../src/findings/collect.ts";
import { GUIDES } from "../src/findings/guide.ts";
import { formatAgent } from "../src/report/agent.ts";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

const TIME_AGO = `(date) {
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  return Math.floor(seconds / 3600) + "h ago";
}`;

async function findings(files: Record<string, string>) {
  return collectFindings(await scanRepo(await makeRepo(files)));
}

test("every rule has a name, a why, steps, a safety level and a check", () => {
  for (const [rule, g] of Object.entries(GUIDES)) {
    assert.ok(g.name && g.why && g.fix.length && g.verify, rule);
    assert.ok(["safe", "ask-first", "warning"].includes(g.safety), rule);
  }
});

test("findings carry their evidence: the other copies, every caller", async () => {
  const found = await findings({
    "a.js": `export function timeAgo${TIME_AGO}\n`,
    "b.js": `export function fileTimeAgo${TIME_AGO}\n`,
    "index.js": `function slab(x0, y0, size, height, taper, z0) { return [x0, y0, size, height, taper, z0]; }\nexport const a = slab(1, 2, 3, 4, 5, 6);\nexport const b = slab(0, 0, 1, 1, 1, 0);\n`,
  });
  const copy = found.find((f) => f.rule === "exact-copy")!;
  assert.equal(copy.title, "2 copies of timeAgo / fileTimeAgo");
  assert.deepEqual(copy.related, [{ file: "b.js", line: 1, label: "copy: fileTimeAgo" }]);
  const params = found.find((f) => f.rule === "long-params")!;
  assert.equal(params.title, "slab: 6 parameters (x0, y0, size, height, taper, z0)");
  assert.deepEqual(params.related.map((p) => `${p.file}:${p.line}`), ["index.js:2", "index.js:3"]);
  assert.equal(params.safety, "ask-first");
  assert.match(params.id, /^long-params:index\.js:1$/);
});

test("--agent: grouped by rule, the guidance once, hints left out unless asked", async () => {
  const found = await findings({
    "a.js": `export function timeAgo${TIME_AGO}\n`,
    "b.js": `export function fileTimeAgo${TIME_AGO}\n`,
    "c.js": `export function again${TIME_AGO}\n`,
    "index.js": `// const old = load();\nexport const x = 1;\n`,
  });
  const text = formatAgent("/repo", found, false);
  assert.match(text, /## Exact copies \(1\)\n\nWhy: .+\nSafety: ask the user first\n\n- a\.js:1-6: 3 copies/);
  assert.match(text, /## Commented-out code \(1\)\n\nWhy: .+\nSafety: safe to fix on its own/);
  assert.equal(text.match(/Why: A fix made in one copy/g)!.length, 1);
  assert.equal(formatAgent("/repo", [], false).trimEnd().split("\n").at(-1), "Nothing to fix.");
});

test("a file nothing imports yet still has its security problems: an agent's new file starts unused", async () => {
  const found = await findings({
    "package.json": JSON.stringify({ dependencies: { express: "4.19.2" } }),
    "src/main.js": "export const main = () => 1;\n",
    "src/db.js": `export async function findUser(db, id) {\n  try { return db.get(id); } catch (e) {}\n}\nexport const OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";\n`,
  });
  const inDb = found.filter((f) => f.file === "src/db.js").map((f) => f.rule).sort();
  assert.deepEqual(inDb, ["hardcoded-secret", "unused-file"], "the secret counts; clean-up inside the dead file doesn't");
});

test("code shown in a report never carries a key: it's cut to its first characters", async () => {
  const found = await findings({
    "src/a.js": `export function getKey() {\n  return "sk-proj-QQQQrrrrSSSStttUUUUvvvvWWWW1234";\n}\nexport function token() {\n  return "f8Kq2Lm9Zx4Wv7Np3Rt6";\n}\n`,
    "src/main.js": `import { getKey, token } from "./a.js";\nconsole.log(getKey(), token());\n`,
  });
  const shown = JSON.stringify(found);
  assert.doesNotMatch(shown, /QQQQrrrr|f8Kq2Lm9/);
  assert.match(found.find((f) => f.file === "src/a.js" && f.line === 2)!.plain!.does ?? "", /"sk-p…"/);
});
