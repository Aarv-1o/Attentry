import assert from "node:assert/strict";
import { test } from "node:test";
import { collectFindings } from "../src/findings/collect.ts";
import { condition, describe } from "../src/findings/plain.ts";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

async function findings(files: Record<string, string>) {
  return collectFindings(await scanRepo(await makeRepo(files)));
}

test("an unused function is explained, with what likely replaced it", async () => {
  const found = await findings({
    "player.ts": `import { respawn } from "./spawn";
export interface Player { health: number; die(): void }

function resetPlayer(player: Player) {
  if (player.health <= 0) {
    player.die();
    player.health = 100;
  }
}

export function handleDeath(player: Player) {
  if (player.health > 0) return;
  player.die();
  respawn(player);
}
`,
    "spawn.ts": `export function respawn(p: unknown) { return p; }\n`,
    "combat.ts": `import { handleDeath } from "./player";\nexport const hit = (p: any) => { p.health -= 10; handleDeath(p); };\nexport const fall = (p: any) => handleDeath(p);\n`,
  });
  const dead = found.find((f) => f.rule === "dead-function" && f.title.includes("resetPlayer"))!;
  assert.equal(dead.plain?.does, "`resetPlayer(player)`: when `player.health` is 0 or less, it calls `player.die()` and sets `player.health` to 100.");
  assert.equal(dead.plain?.replacedBy, "Probably replaced by `handleDeath` (player.ts:11): it also uses `health` and `die()`, and it's used in 2 places.");
});

test("a guard clause reads as the condition the rest runs under", async () => {
  const found = await findings({ "index.js": `function save(user) {\n  if (!user) return;\n  db.insert(user);\n}\n` });
  assert.equal(found.find((f) => f.rule === "dead-function")!.plain?.does, "`save(user)`: when `user` is set, it calls `db.insert()`.");
});

test("an unused function with nothing similar gets no replacement", async () => {
  const found = await findings({ "index.js": `function calcTax(total) {\n  return total * 0.18;\n}\nexport function sum(a, b) { return a + b; }\n` });
  const dead = found.find((f) => f.rule === "dead-function")!;
  assert.equal(dead.plain?.does, "`calcTax(total)`: it returns `total * 0.18`.");
  assert.equal(dead.plain?.replacedBy, undefined);
});

test("conditions in words", () => {
  assert.equal(condition("player.health <= 0"), "`player.health` is 0 or less");
  assert.equal(condition("NOT player.health > 0"), "`player.health` is 0 or less");
  assert.equal(condition("user && user.active"), "`user` is set and `user.active` is set");
  assert.equal(condition("NOT a && b"), "`a` is missing or `b` is missing");
  assert.equal(condition("x is None"), "`x` is empty");
  assert.equal(condition("items.some((i) => i.qty > 5)"), "`items.some((i) => i.qty > 5)`");
});

test("chained calls are named once, JSX and objects read as what they are", async () => {
  const found = await findings({ "index.tsx": `async function getPlan(id) {\n  const u = await User.findById(id).select("plan").lean();\n  return { plan: u.plan, id };\n}\nfunction Icon({ size }) {\n  return (\n    <svg width={size} />\n  );\n}\nfunction age(d) {\n  return Math.floor((Date.now() - new Date(d).getTime()) / 1000);\n}\n` });
  const said = (name: string) => found.find((f) => f.rule === "dead-function" && f.title.includes(name))!.plain?.does;
  assert.equal(said("getPlan"), "`getPlan(id)`: it calls `User.findById().select().lean()` and returns an object `{ plan, id }`.");
  assert.equal(said("Icon"), "`Icon({ size })`: it shows `<svg>`.");
  assert.equal(said("age"), "`age(d)`: it calls `Date.now()` and `new Date().getTime()`, and returns `Math.floor((Date.now() - new Date(d).ge…`.");
});

test("a call in a condition is true or false", () => {
  assert.equal(condition("mongoose.isValidObjectId(id)"), "`mongoose.isValidObjectId(id)` is true");
  assert.equal(condition("NOT isValid(id)"), "`isValid(id)` is false");
  assert.equal(condition("!isValid(id)"), "`isValid(id)` is false");
});

test("built strings read as words, not code", async () => {
  const found = await findings({ "index.js": "function render(app, name) {\n  app.innerHTML = `<div>${name}</div>`;\n}\nfunction label(n) {\n  return `${n} items`;\n}\n" });
  const said = (name: string) => found.find((f) => f.rule === "dead-function" && f.title.includes(name))!.plain?.does;
  assert.equal(said("render"), "`render(app, name)`: it sets `app.innerHTML` to HTML.");
  assert.equal(said("label"), "`label(n)`: it returns a text.");
});

test("a long function: the step count only when there are many", () => {
  const facts = { file: "a.tsx", startLine: 1, name: "Home", params: "", when: undefined, calls: ["render"], changes: [], returns: [], touches: [] };
  assert.match(describe({ ...facts, endLine: 128, steps: 1 }) ?? "", /^`Home\(\)` is 128 lines: it/);
  assert.match(describe({ ...facts, endLine: 20, steps: 15 }) ?? "", /^`Home\(\)` is 20 lines with 15 steps: it/);
});
