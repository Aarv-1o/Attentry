import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

// Two apps side by side in a folder that isn't a repo (a folder of checkouts), each with the
// same /api/notes/:id path and the same helper.
const HAVERSINE = "export function distance(a, b) {\n  const dLat = b.lat - a.lat;\n  const dLng = b.lng - a.lng;\n  return Math.sqrt(dLat * dLat + dLng * dLng) * 111;\n}\n";
const FOLDER = {
  "demo/package.json": "{}",
  "demo/server/app.js": `const app = express();\napp.put("/api/notes/:id", save);\napp.get("/api/notes", list);\n`,
  "demo/public/app.js": `fetch("/api/notes");\nfetch(\`/api/notes/\${id}\`, { method: "PATCH" });\n`,
  "demo/geo.js": HAVERSINE,
  "tests-demo/package.json": "{}",
  "tests-demo/src/app.js": `const app = express();\napp.put("/api/notes/:id", save);\napp.delete("/api/notes/:id", remove);\n`,
  "other/package.json": "{}",
  "other/geo.js": HAVERSINE,
};

test("a folder of separate projects: calls, routes and copies stay inside each project", async () => {
  const scan = await scanRepo(await makeRepo(FOLDER));
  const wrong = scan.crossStack.missing.find((m) => m.kind === "wrong-method");
  assert.equal(wrong?.closest?.file, "demo/server/app.js", "the route in the call's own project");
  assert.deepEqual(wrong?.methods, ["PUT"], "not merged with the other project's DELETE");
  assert.deepEqual(scan.crossStack.unused.map((u) => `${u.route.file} ${u.route.method}`), ["demo/server/app.js PUT"], "a backend with no frontend of its own isn't checked against another's");
  assert.equal(scan.crossStack.unused[0]?.calls, 2, "its own project's calls");
  assert.equal(scan.groups.length, 0, "the same helper in two projects isn't a copy to merge");
});

test("a git repo is one project: its frontend still reaches its backend", async () => {
  const root = await makeRepo({ "client/package.json": "{}", "client/app.js": `fetch("/api/notes");\n`, "server/package.json": "{}", "server/app.js": `const app = express();\napp.get("/api/notes", list);\n` });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const scan = await scanRepo(root);
  assert.equal(scan.crossStack.calls, 1);
  assert.deepEqual(scan.crossStack.unused, []);
});
