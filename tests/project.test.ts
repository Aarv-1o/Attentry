import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chooseProject, projectRoot, projectsIn } from "../src/index/project.ts";
import { makeRepo, withHome } from "./helpers.ts";

test("the project in a folder opened one level too high", async () => {
  // An unzipped repo, alone in its download folder.
  const zip = await makeRepo({ "Zextiria-Rooms-main/backend/main.py": "", "Zextiria-Rooms-main/README.md": "" });
  assert.equal(await projectRoot(zip), join(zip, "Zextiria-Rooms-main"));
  // Several folders, one of them a checkout: that one (bundles and patches beside it don't count).
  const many = await makeRepo({ "De-Tron/src/a.ts": "", "notes/x.md": "", "update.patch": "" });
  await mkdir(join(many, "De-Tron/.git"));
  assert.equal(await projectRoot(many), join(many, "De-Tron"));
  // A project itself: stays.
  const own = await makeRepo({ "package.json": "{}", "web/a.ts": "" });
  assert.equal(await projectRoot(own), own);
  const git = await makeRepo({ "only/a.ts": "" });
  await mkdir(join(git, ".git"));
  assert.equal(await projectRoot(git), git, "a git repo is the project, even with one folder in it");
  // Two projects side by side: no guessing.
  const two = await makeRepo({ "a/package.json": "{}", "b/package.json": "{}" });
  assert.equal(await projectRoot(two), two);
  // A repo whose code is all in src/ is the project, not src/.
  const srcOnly = await makeRepo({ "src/main.ts": "", "src/util.ts": "" });
  assert.equal(await projectRoot(srcOnly), srcOnly);
});

test("a folder of several projects: the one the person chose, for everything that asks", () => withHome({}, async () => {
  // The two code folders from the person's screenshot: neither a git checkout, both projects.
  const folder = await makeRepo({ "chat-final/package.json": "{}", "ridely/package.json": "{}", "notes/todo.txt": "" });
  assert.deepEqual(await projectsIn(folder), ["chat-final", "ridely"].map((p) => join(folder, p)), "folders that aren't projects aren't offered");
  assert.equal(await projectRoot(folder), folder, "no choice yet: all of it");
  await chooseProject(folder, join(folder, "ridely"));
  assert.equal(await projectRoot(folder), join(folder, "ridely"));
  assert.equal(await projectRoot(join(folder, ".")), join(folder, "ridely"), "however the folder is spelled");
  await chooseProject(folder, folder);
  assert.equal(await projectRoot(folder), folder, "all of it, chosen");
  await chooseProject(folder, join(folder, "chat-final"));
  await rm(join(folder, "chat-final"), { recursive: true });
  assert.equal(await projectRoot(folder), folder, "the chosen one deleted: found again, as with no choice");
  await chooseProject(folder, join(folder, "ridely"));
  await chooseProject(folder, undefined);
  assert.equal(await projectRoot(folder), folder, "the choice forgotten");
}));
