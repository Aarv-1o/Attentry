import assert from "node:assert/strict";
import { test } from "node:test";
import { relatedCode } from "../src/agent/related.ts";
import { Sessions } from "../src/agent/session.ts";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

const REPO = {
  "src/utils/time.js": `export function timeAgo(date) {\n  const seconds = Math.floor((Date.now() - new Date(date)) / 1000);\n  if (seconds < 3600) return Math.floor(seconds / 60) + " minutes ago";\n  return Math.floor(seconds / 3600) + " hours ago";\n}\n`,
  "src/utils/money.js": `export function formatPrice(cents) {\n  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);\n}\n`,
  "src/utils/user.js": `export function getUser(id) {\n  return fetch("/api/users/" + id).then((r) => r.json());\n}\n`,
  "server.js": `const express = require("express");\nconst app = express();\napp.get("/api/rides/:id", (req, res) => res.json({}));\napp.post("/api/users", (req, res) => res.json({}));\napp.listen(3000);\n`,
  "package.json": JSON.stringify({ dependencies: { express: "4" } }),
};

const REQUEST = "Build a ride history page: past rides with a relative time like '3 hours ago' and a formatted price.";

test("related code: the helpers and routes a request is about, and nothing it isn't", async () => {
  const scan = await scanRepo(await makeRepo(REPO));
  assert.deepEqual(relatedCode(REQUEST, scan), [
    "`timeAgo` in src/utils/time.js:1 (used in 0 places)",
    "`formatPrice` in src/utils/money.js:1 (used in 0 places)",
    "GET /api/rides/:id in server.js:3",
  ]);
  assert.deepEqual(relatedCode("fix the typo", scan), [], "a short request");
  assert.deepEqual(relatedCode("Make the login screen look nicer on phones please", scan), []);
});

test("related code: told to Claude with the request, once per session", async () => {
  const sessions = new Sessions(await makeRepo(REPO));
  const ask = async (prompt: string) => {
    const reply = await sessions.handle({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt });
    return reply.stdout ? JSON.parse(reply.stdout).hookSpecificOutput : undefined;
  };
  const told = await ask(REQUEST);
  assert.equal(told.hookEventName, "UserPromptSubmit");
  assert.match(told.additionalContext, /^Attentry: the repo already has code related to this request\. Reuse or extend it rather than writing it again:\n- `timeAgo`/);
  assert.equal(await ask(REQUEST), undefined, "already heard");
});
