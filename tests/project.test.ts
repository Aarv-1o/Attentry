import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "../src/index/project.ts";
import { makeRepo } from "./helpers.ts";

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
