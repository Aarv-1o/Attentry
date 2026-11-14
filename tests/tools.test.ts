import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Sessions } from "../src/agent/session.ts";
import { COPY, REPO } from "./agentRepo.ts";
import { makeRepo } from "./helpers.ts";

test("find_existing: by what it should do, or by the code about to be written", async () => {
  const sessions = new Sessions(await makeRepo(REPO));
  const byWords = await sessions.tool("find_existing", { query: "format time ago" });
  assert.match(byWords.text, /`timeAgo\(date\)` in src\/utils\/time\.js:1, used in 1 place \(exported: import it\)/);
  assert.match((await sessions.tool("find_existing", { query: "send an invoice email" })).text, /^Nothing in the repo looks like/);
  // How agents really ask: long, with words the name doesn't have.
  assert.match((await sessions.tool("find_existing", { query: "format a date as relative time ago text like '5m ago'" })).text, /`timeAgo\(date\)` in src\/utils\/time\.js:1/);
  const byCode = await sessions.tool("find_existing", { code: COPY, file: "src/comments.js" });
  assert.match(byCode.text, /`commentAge`: `timeAgo` in src\/utils\/time\.js:1 \(used in 1 place\) has the same code, only the names differ\. Import it\./);
  assert.equal((await sessions.tool("find_existing", {})).isError, true);
  assert.equal((await sessions.tool("find_existing", { code: COPY })).isError, true, "code needs a file or a language");
  assert.equal((await sessions.tool("find_existing", { query: 42 })).isError, true, "arguments of the wrong type count as missing");
  for (const outside of ["../../../etc/passwd.js", "/etc/passwd.js", "src/../../secret.js"]) {
    assert.match((await sessions.tool("find_existing", { code: COPY, file: outside })).text, /is outside the project/, outside);
  }
});

test("check and explain: problems in given files, with what this task added marked", async () => {
  const root = await makeRepo({ ...REPO, "src/api.js": "export function load(url) {\n  try {\n    return fetch(url);\n  } catch (e) {}\n}\n" });
  const sessions = new Sessions(root);
  await sessions.handle({ hook_event_name: "SessionStart", session_id: "s1" });
  await writeFile(join(root, "src/save.js"), "export function save(x) {\n  try {\n    db.put(x);\n  } catch (e) {}\n}\n");
  await sessions.handle({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Write", tool_input: { file_path: join(root, "src/save.js") } });
  const checked = await sessions.tool("check", { files: ["src/api.js", join(root, "src/save.js")] });
  assert.match(checked.text, /^2 problems and 0 clean-up items in 2 files in attentry-\w+\.\nProblems:\n/);
  assert.match(checked.text, /src\/save\.js:4 warning attentry\/empty-catch: .+ \(new in this task\)/);
  assert.doesNotMatch(checked.text, /src\/api\.js:4 .+new in this task/, "the old one isn't this task's");
  assert.match((await sessions.tool("explain", { location: "src/save.js:4" })).text, /## Errors silently ignored \(1\)/);
  assert.equal((await sessions.tool("explain", { location: "src/save.js:1" })).text, "No findings on src/save.js:1. Findings in src/save.js are on line 4.");
  assert.equal((await sessions.tool("explain", { location: "nowhere" })).isError, true);
  assert.equal((await sessions.tool("rewrite", {})).isError, true);
});

test("check lists clean-up too, with the other copy to reuse: the agent can't open a report", async () => {
  const root = await makeRepo(REPO);
  const sessions = new Sessions(root);
  await sessions.handle({ hook_event_name: "SessionStart", session_id: "s1" });
  await writeFile(join(root, "src/save.js"), `export const save = (x) => x;\n${COPY}`);
  await sessions.handle({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Write", tool_input: { file_path: join(root, "src/save.js") } });
  const checked = await sessions.tool("check", { files: ["src/save.js"] });
  assert.match(checked.text, /^0 problems and 2 clean-up items in 1 file in attentry-\w+\.\nClean-up \(unused or copied code: do it in its own step, apart from the feature\):\n/);
  assert.match(checked.text, /src\/save\.js:2 info attentry\/exact-copy: 2 copies of commentAge \/ timeAgo \(copy: timeAgo at src\/utils\/time\.js:1\) \(new in this task\)/);
});

test("check never says no problems about files it didn't read, and says why for each", async () => {
  const root = await makeRepo({ ...REPO, "README.md": "# app\n" });
  const sessions = new Sessions(root);
  const game = join(root, "..", "tennis", "game.js");
  const mixed = await sessions.tool("check", { files: ["src/utils/time.js", game, "does/not/exist.ts", "README.md"] });
  assert.match(mixed.text, /^No problems in 1 file in attentry-\w+\.\n/, "only the file it read counts");
  assert.match(mixed.text, /Not checked, outside attentry-\w+ \(the project Attentry reads\): .*tennis.game\.js\. To check them, open their folder in the editor\./);
  assert.match(mixed.text, /Not checked, not found in attentry-\w+: does\/not\/exist\.ts\./);
  assert.match(mixed.text, /Not checked, not code Attentry reads .*: README\.md\./);
  const none = await sessions.tool("check", { files: [game, "does/not/exist.ts"] });
  assert.match(none.text, /^Attentry didn't check any of these files\.\nNot checked, outside/);
  assert.doesNotMatch(none.text, /No problems/);
});
