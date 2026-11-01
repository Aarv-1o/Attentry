import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { makeRepo } from "./helpers.ts";
import { isSource, isTestFile, listRepoFiles } from "../src/index/files.ts";

const sourceFiles = async (root: string) => (await listRepoFiles(root)).filter(isSource);

const FILES = {
  "src/app.ts": "",
  "src/ui/Page.tsx": "",
  "server/main.py": "",
  "README.md": "",
  "public/vendor.min.js": "",
  "node_modules/lib/index.js": "",
  "dist/bundle.js": "",
};

test("outside git: walks the folder and skips junk folders", async () => {
  const root = await makeRepo(FILES);
  assert.deepEqual(await sourceFiles(root), ["server/main.py", "src/app.ts", "src/ui/Page.tsx"]);
});

test("skips coding agents' folders: installed skills aren't the app's code", async () => {
  const root = await makeRepo({ ...FILES, ".agents/skills/maps/prep.mjs": "", "video/.claude/skills/x/run.py": "", ".github/workflows/ci.js": "" });
  assert.deepEqual(await sourceFiles(root), [".github/workflows/ci.js", "server/main.py", "src/app.ts", "src/ui/Page.tsx"]);
});

test("inside git: follows .gitignore, including untracked files", async () => {
  const root = await makeRepo({ ...FILES, ".gitignore": "dist/\nnode_modules/\ngenerated/\n", "generated/api.ts": "" });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "src/app.ts"], { cwd: root });
  assert.deepEqual(await sourceFiles(root), ["server/main.py", "src/app.ts", "src/ui/Page.tsx"]);
});

test("isTestFile: test folders, .test/.spec files, test.js, Python test_ and _test", () => {
  for (const f of ["tests/a.ts", "src/__tests__/a.tsx", "a.test.ts", "b.spec.js", "body-parsing/test.js", "test_api.py", "api_test.py"]) {
    assert.ok(isTestFile(f), f);
  }
  for (const f of ["src/latest.js", "contest.py", "src/testing-utils.ts", "attestation.ts"]) assert.ok(!isTestFile(f), f);
});
