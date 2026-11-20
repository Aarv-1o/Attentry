import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { makeRepo, withHome } from "./helpers.ts";
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

test("skips test fixtures: sample code, often wrong on purpose", async () => {
  const root = await makeRepo({ ...FILES, "tests/fixtures/bad/app.js": "", "src/__fixtures__/x.ts": "", "src/fixtures.ts": "" });
  assert.deepEqual(await sourceFiles(root), ["server/main.py", "src/app.ts", "src/fixtures.ts", "src/ui/Page.tsx"]);
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

test("inside git with no .gitignore yet: installed packages are still skipped", async () => {
  const root = await makeRepo({ ...FILES, ".venv/lib/site.py": "" });
  execFileSync("git", ["init", "-q"], { cwd: root });
  assert.deepEqual(await sourceFiles(root), ["dist/bundle.js", "server/main.py", "src/app.ts", "src/ui/Page.tsx"]);
});

test("inside git: a folder link back up the repo isn't followed (each file once)", async () => {
  const root = await makeRepo({ ...FILES, ".gitignore": "dist/\nnode_modules/\n" });
  execFileSync("git", ["init", "-q"], { cwd: root });
  symlinkSync(root, join(root, "src", "loop"), "junction"); // Git for Windows lists a junction like a folder
  assert.deepEqual(await sourceFiles(root), ["server/main.py", "src/app.ts", "src/ui/Page.tsx"]);
});

test("isTestFile: test folders, .test/.spec files, test.js, Python test_, _test and Django's tests.py", () => {
  for (const f of ["tests/a.ts", "src/__tests__/a.tsx", "a.test.ts", "b.spec.js", "body-parsing/test.js", "test_api.py", "api_test.py", "notes/tests.py"]) {
    assert.ok(isTestFile(f), f);
  }
  for (const f of ["src/latest.js", "contest.py", "contests.py", "src/testing-utils.ts", "attestation.ts"]) assert.ok(!isTestFile(f), f);
});

test("the home folder isn't walked: the agent is told to open a project", () => withHome({ "notes/a.js": "" }, async (home) => {
  await assert.rejects(listRepoFiles(home), /your home folder, not a project/);
  // A home folder kept in git (dotfiles) lists only what git tracks: fine to read.
  execFileSync("git", ["init", "-q"], { cwd: home });
  assert.deepEqual(await listRepoFiles(home), ["notes/a.js"]);
}));

// A folder this user can't open, inside the project, is skipped instead of ending the scan.
// Windows only: denying a folder needs icacls (chmod can't, and root ignores it elsewhere).
test("a folder that can't be read is skipped", { skip: process.platform !== "win32" }, async () => {
  const root = await makeRepo({ "app/server.js": "", "locked/a.js": "" });
  execFileSync("icacls", [join(root, "locked"), "/deny", "*S-1-1-0:(OI)(CI)(RD)"]);
  try {
    assert.deepEqual(await listRepoFiles(root), ["app/server.js"]);
  } finally {
    execFileSync("icacls", [join(root, "locked"), "/remove:d", "*S-1-1-0"]);
  }
});
