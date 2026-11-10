import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex } from "../src/index/repo.ts";
import { findCrossStack, takes } from "../src/rules/crossStack/check.ts";
import { htmlCallsIn } from "../src/rules/crossStack/htmlCalls.ts";
import type { FileApi } from "../src/rules/crossStack/types.ts";
import { makeRepo } from "./helpers.ts";

// Findings as "kind METHOD /path file:line" lines.
async function crossStack(files: Record<string, string>): Promise<string[]> {
  const root = await makeRepo(files);
  const index = await buildIndex(root);
  const apis = new Map<string, FileApi>([...index.scans].map(([file, s]) => [file, s.api]));
  const imports = new Map([...index.usage].map(([file, u]) => [file, u.imports]));
  const result = findCrossStack(apis, imports, await htmlCallsIn(root, index.allFiles));
  return [
    ...result.missing.map((m) => `${m.kind} ${m.confidence} ${m.method} ${m.path.text} ${m.file}:${m.line}${m.closest ? ` ~ ${m.closest.path.text}` : ""}`),
    ...result.unused.map((u) => `unused ${u.confidence} ${u.route.method} ${u.route.path.text} ${u.route.file}:${u.route.line}`),
  ].sort();
}

const EXPRESS = {
  "server/index.js": `import express from "express";
import { createUsersRouter } from "./routes/users.js";
const app = express();
app.use(express.json());
app.use("/api/users", auth, createUsersRouter(db));
app.post("/api/webhooks/stripe", (req, res) => res.send());
app.get("/{*splat}", (req, res) => res.sendFile("index.html"));
`,
  "server/routes/users.js": `import { Router } from "express";
export function createUsersRouter(db) {
  const router = Router();
  router.get("/", (req, res) => res.json([]));
  router.get("/:id", (req, res) => res.json({}));
  router.route("/:id/avatar").put(upload).delete(remove);
  router.post("/export", (req, res) => res.send());
  return router;
}
`,
};

test("Express: mounted routers, calls via constants, typos and wrong methods", async () => {
  const found = await crossStack({
    ...EXPRESS,
    "src/pages/Users.tsx": `const API = "/api/users";
export async function load(id: string) {
  await fetch(API);
  await fetch(\`\${API}/\${id}\`);
  await fetch(\`\${API}/\${id}/avatar\`, { method: "PUT" });
  await fetch(\`/api/user/\${id}\`);
  await fetch(\`\${API}/\${id}\`, { method: "POST" });
  await fetch("https://api.stripe.com/v1/charges");
}
`,
  });
  assert.deepEqual(found, [
    "missing-route likely GET /api/user/… src/pages/Users.tsx:6 ~ /api/users/:id",
    "unused likely DELETE /api/users/:id/avatar server/routes/users.js:6",
    "unused likely POST /api/users/export server/routes/users.js:7",
    "wrong-method likely POST /api/users/… src/pages/Users.tsx:7 ~ /api/users/:id",
  ]);
});

test("FastAPI and Flask: router prefixes, include_router, HTML pages and forms", async () => {
  const found = await crossStack({
    "app/main.py": `from fastapi import FastAPI
from app.api.chat import router as chat_router
from app.api import news
app = FastAPI()
app.include_router(chat_router)
app.include_router(news.router, prefix="/v1")
`,
    "app/api/chat.py": `from fastapi import APIRouter
router = APIRouter(prefix="/api")
@router.post("/chat/stream")
async def stream(): ...
@router.get("/chat/{chat_id}")
async def get_chat(chat_id: str): ...
`,
    "app/api/news.py": `from fastapi import APIRouter
router = APIRouter(prefix="/news")
@router.get("/travel")
def travel(): ...
`,
    "flask_app.py": `from flask import Flask
app = Flask(__name__)
@app.route("/login", methods=["GET", "POST"])
def login(): ...
`,
    "static/chat.js": `fetch('/api/chat/stream', { method: 'POST', body });\nfetch('/api/chats/' + id);\n`,
    "static/news.html": `<script>fetch('/v1/news/travel?count=9')</script>\n<form action="/login" method="post"></form>`,
  });
  assert.deepEqual(found, [
    "missing-route likely GET /api/chats/… static/chat.js:2 ~ /api/chat/{chat_id}",
    "unused likely GET /api/chat/{chat_id} app/api/chat.py:5",
  ]);
});

// A helper that takes the method: fetch(url, { method }) can be any of them (a game posting scores).
test("does not flag: a route reached through a helper that passes the method as a variable", async () => {
  assert.deepEqual(await crossStack({
    "server.js": `import express from "express";
const app = express();
app.get("/scores", (req, res) => res.json([]));
app.post("/scores", (req, res) => res.status(201).json({}));
`,
    "public/game.js": `async function request(method, body) {
  return fetch("/scores", { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
}
request("GET");
request("POST", { name, score });
`,
  }), []);
});

test("does not flag: unknown base URLs, other hosts, webhooks, repos with no backend", async () => {
  assert.deepEqual(await crossStack({
    ...EXPRESS,
    "src/api.ts": `const BASE = import.meta.env.VITE_API_URL;
export const all = () => fetch(\`\${BASE}/users\`);
export const one = (id: string) => apiFetch(\`/api/users/\${id}\`);
export const avatar = (id: string, path: string) => fetch(\`/api/users/\${id}/avatar\${path}\`);
export const send = (endpoint: string) => fetch(\`\${BASE}\${endpoint}\`);
export const upload = (id: string) => { const x = new XMLHttpRequest(); x.open("PUT", \`/api/users/\${id}/avatar\`); x.open("DELETE", \`/api/users/\${id}/avatar\`); };
export const list = () => fetch("/api/users");
export const exp = () => axios.post("/api/users/export");
`,
    "src/Avatar.tsx": `export const Avatar = ({ id }) => <img src={"/api/users/" + id} alt="" />;
export const Nav = () => <a href="/dashboard">Home</a>;
`,
  }), []);
  assert.deepEqual(await crossStack({ "src/a.ts": `fetch("/api/anything");` }), []);
});

test("a typo means the nearly-same route, and a wrong method lists every method the route takes", async () => {
  const root = await makeRepo({
    "server.js": `import express from "express";
const app = express();
app.get("/api/notes/:id", (req, res) => res.json({}));
app.put("/api/notes/:id", (req, res) => res.json({}));
app.delete("/api/shared/:id", (req, res) => res.end());
`,
    "public/app.js": `export const open = (id) => fetch(\`/api/note/\${id}\`);
export const rename = (id) => fetch(\`/api/notes/\${id}\`, { method: "PATCH" });
export const remove = (id) => fetch(\`/api/shared/\${id}\`, { method: "DELETE" });
`,
  });
  const index = await buildIndex(root);
  const apis = new Map<string, FileApi>([...index.scans].map(([file, s]) => [file, s.api]));
  const result = findCrossStack(apis, new Map([...index.usage].map(([file, u]) => [file, u.imports])), await htmlCallsIn(root, index.allFiles));
  const typo = result.missing.find((m) => m.kind === "missing-route");
  assert.equal(typo?.closest?.path.text, "/api/notes/:id");
  const wrong = result.missing.find((m) => m.kind === "wrong-method");
  assert.deepEqual(wrong?.methods?.sort(), ["GET", "PUT"]);
  assert.equal(takes(wrong!), "The route takes GET and PUT");
});
