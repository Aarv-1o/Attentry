import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex } from "../src/index/repo.ts";
import { routeCoverage } from "../src/testing/coverage.ts";
import { makeRepo } from "./helpers.ts";

// Each route as "METHOD /path <- test:line, ..." or "METHOD /path untested".
async function coverage(files: Record<string, string>): Promise<string[]> {
  const index = await buildIndex(await makeRepo(files));
  return routeCoverage(index)
    .map(({ route, tests }) => `${route.method} ${route.path.text} ${tests.length ? `<- ${tests.map((t) => `${t.file}:${t.line}`).join(", ")}` : "untested"}`)
    .sort();
}

const expressApp = {
  "src/app.ts": `import express from "express";
import notes from "./notes";
export const app = express();
app.use("/api/notes", notes);
`,
  "src/notes.ts": `import { Router } from "express";
const router = Router();
router.get("/", list);
router.get("/:id", show);
router.post("/", create);
router.delete("/:id", remove);
export default router;
`,
};

test("Express + supertest: direct calls, agents, and what must not count", async () => {
  assert.deepEqual(await coverage({
    ...expressApp,
    "tests/notes.test.ts": `import request from "supertest";
import { app } from "../src/app";
// request(app).post("/api/notes") is only a comment
let agent;
beforeEach(() => { agent = request.agent(app); });
test("list", async () => { await request(app).get("/api/notes?page=2").expect(200); });
test("delete", async () => { await agent.delete(\`/api/notes/\${id}\`).expect(204); });
test("mocked", async () => { await fetch("/api/notes", { method: "POST" }); expect(url).toBe("/api/notes/1"); });
`,
    // Not a test file: a script calling the app doesn't make a route tested.
    "scripts/seed.ts": `import request from "supertest";\nrequest(app).post("/api/notes");\n`,
  }), [
    "DELETE /api/notes/:id <- tests/notes.test.ts:7",
    "GET /api/notes <- tests/notes.test.ts:6",
    "GET /api/notes/:id untested",
    "POST /api/notes untested",
  ]);
});

test("NestJS, Fastify inject and Hono app.request", async () => {
  assert.deepEqual(await coverage({
    "nest/main.ts": `const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix("api");\n`,
    "nest/articles.controller.ts": `@Controller("articles")
export class ArticlesController {
  @Get() findAll() {}
  @Delete(":slug") remove() {}
}
`,
    "nest/test/articles.e2e-spec.ts": `it("lists", () => request(app.getHttpServer()).get("/api/articles").expect(200));\n`,
    "fastify/server.ts": `const app = Fastify();\napp.get("/health", h);\napp.post("/items", { preHandler: [auth] }, create);\napp.put("/items/:id", update);\n`,
    "fastify/server.test.ts": `const res = await app.inject({ method: "POST", url: "/items", payload: {} });
const ok = await app.inject({ url: "/health" });
await app.inject().put("/items/3");
`,
    "hono/index.ts": `const app = new Hono();\napp.get("/posts", list);\napp.delete("/posts/:id", remove);\n`,
    "hono/index.test.ts": `const res = await app.request("/posts/1", { method: "DELETE" });\n`,
  }), [
    "DELETE /api/articles/:slug untested",
    "DELETE /posts/:id <- hono/index.test.ts:1",
    "GET /api/articles <- nest/test/articles.e2e-spec.ts:1",
    "GET /health <- fastify/server.test.ts:2",
    "GET /posts untested",
    "POST /items <- fastify/server.test.ts:1",
    "PUT /items/:id <- fastify/server.test.ts:3",
  ]);
});

test("Next.js: a test that imports the route's handler reaches it", async () => {
  assert.deepEqual(await coverage({
    "app/api/notes/[id]/route.ts": `export async function GET(req: Request) {}\nexport async function DELETE(req: Request) {}\n`,
    "app/api/notes/[id]/route.test.ts": `import { GET } from "./route";\ntest("get", async () => { await GET(new Request("http://x")); });\n`,
  }), [
    "DELETE /api/notes/[id] untested",
    "GET /api/notes/[id] <- app/api/notes/[id]/route.test.ts:1",
  ]);
});

test("FastAPI TestClient and Flask test_client", async () => {
  assert.deepEqual(await coverage({
    "api/main.py": `from fastapi import FastAPI
app = FastAPI()

@app.get("/items/{item_id}")
def read_item(item_id: int): ...

@app.delete("/items/{item_id}")
def delete_item(item_id: int): ...
`,
    "api/tests/test_items.py": `from fastapi.testclient import TestClient
from api.main import app
client = TestClient(app)

def test_read():
    assert client.get(f"/items/{42}").status_code == 200

def test_outside():
    requests.delete("https://example.com/items/1")
    client.delete(reverse("item-detail"))
`,
    // Backend code calling another service with a client named `client`: not a test.
    "api/sync.py": `client.delete("/items/1")\n`,
    "web/app.py": `from flask import Flask
app = Flask(__name__)

@app.route("/login", methods=["GET", "POST"])
def login(): ...
`,
    "web/test_login.py": `def test_login(app):
    with app.test_client() as c:
        c.post("/login", data={"user": "a"})
`,
  }), [
    "DELETE /items/{item_id} untested",
    "GET /items/{item_id} <- api/tests/test_items.py:6",
    "GET /login untested",
    "POST /login <- web/test_login.py:3",
  ]);
});

test("Django: self.client and DRF's APIClient", async () => {
  assert.deepEqual(await coverage({
    "notes/urls.py": `from django.urls import path
from . import views
urlpatterns = [
    path("api/notes/", views.note_list),
    path("api/notes/<int:pk>/", views.note_detail),
]
`,
    "notes/views.py": `def note_list(request): ...\ndef note_detail(request, pk): ...\n`,
    "notes/tests.py": `class NoteTests(TestCase):
    def test_detail(self):
        self.client.get("/api/notes/1/")

def test_create():
    api = APIClient()
    api.post("/api/notes/", {"title": "a"})
`,
  }), [
    "ALL /api/notes <- notes/tests.py:7",
    "ALL /api/notes/<int:pk> <- notes/tests.py:3",
  ]);
});
