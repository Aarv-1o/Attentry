import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildIndex } from "../src/index/repo.ts";
import { commandFor, testsFor } from "../src/testing/select.ts";
import { makeRepo } from "./helpers.ts";

test("the tests for a file: test files that import it, directly or through other files", async () => {
  const index = await buildIndex(await makeRepo({
    "src/money.ts": "export const cents = (n: number) => n * 100;\n",
    "src/cart.ts": `import { cents } from "./money";\nexport const total = (xs: number[]) => cents(xs.length);\n`,
    "src/other.ts": "export const x = 1;\n",
    "tests/money.test.ts": `import { cents } from "../src/money";\ntest("c", () => cents(1));\n`,
    "tests/cart.test.ts": `import { total } from "../src/cart";\ntest("t", () => total([]));\n`,
    "tests/other.test.ts": `import { x } from "../src/other";\n`,
    "tests/helpers.ts": `import { cents } from "../src/money";\nexport const one = cents(1);\n`,
  }));
  assert.deepEqual(testsFor(["src/money.ts"], index), ["tests/cart.test.ts", "tests/money.test.ts"], "not tests/helpers.ts: a helper, not a test");
  assert.deepEqual(testsFor(["src/other.ts"], index), ["tests/other.test.ts"]);
  assert.deepEqual(testsFor(["tests/cart.test.ts"], index), ["tests/cart.test.ts"], "a test file runs itself");
});

test("the command: jest and vitest find related tests themselves; pytest and node --test get the files; others can't be narrowed", () => {
  const root = "/repo";
  const cmd = (runs: string, cwd = root) => ({ cwd, command: "npm test", label: "npm test", runs });
  assert.equal(commandFor(cmd("vitest"), ["src/money.ts"], ["src/a.test.ts"], root, "x")?.command, "npx vitest related --run src/money.ts");
  assert.equal(commandFor(cmd("jest --coverage"), ["src/money.ts"], [], root, "x")?.command, "npx jest --findRelatedTests src/money.ts");
  assert.equal(commandFor(cmd("python -m pytest -q", join(root, "backend")), ["backend/app/m.py"], ["backend/tests/test_a.py"], root, "x")?.command, "python -m pytest -q tests/test_a.py");
  assert.equal(commandFor(cmd(`node --import tsx --test "tests/**/*.test.ts"`), ["src/a.ts"], ["tests/a.test.ts"], root, "x")?.command, "node --import tsx --test tests/a.test.ts");
  assert.equal(commandFor(cmd("mocha"), ["src/a.js"], ["test/a.test.js"], root, "x"), undefined, "mocha: Run all instead");
  assert.equal(commandFor(cmd("pytest"), ["a.py"], ["tests/test a.py"], root, "x"), undefined, "a path the shell would split");
  assert.equal(commandFor(cmd("pytest"), ["a.py"], [], root, "x"), undefined, "no tests for it");
  assert.equal(commandFor(cmd("vitest"), ["src/a.ts"], [], root, "a.ts")?.label, "a.ts");
  // Several files (the changed ones): all of them; another app's files are left to its own command.
  assert.equal(commandFor(cmd("vitest"), ["src/a.ts", "src/b.ts"], [], root, "x")?.command, "npx vitest related --run src/a.ts src/b.ts");
  const backend = cmd("pytest", join(root, "backend"));
  assert.equal(commandFor(backend, ["backend/m.py", "web/a.ts"], ["backend/tests/test_m.py", "web/a.test.ts"], root, "x")?.command, "python -m pytest -q tests/test_m.py");
  assert.equal(commandFor(backend, ["web/a.ts"], ["web/a.test.ts"], root, "x"), undefined, "nothing of its own to run");
});
