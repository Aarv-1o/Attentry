import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex } from "../src/index/repo.ts";
import { findCrossStack } from "../src/rules/crossStack/check.ts";
import type { FileApi } from "../src/rules/crossStack/types.ts";
import { makeRepo } from "./helpers.ts";

// Findings as "kind METHOD /path file:line", plus how many routes were found.
async function crossStack(files: Record<string, string>): Promise<string[]> {
  const root = await makeRepo(files);
  const index = await buildIndex(root);
  const apis = new Map<string, FileApi>([...index.scans].map(([file, s]) => [file, s.api]));
  const result = findCrossStack(apis, new Map([...index.usage].map(([file, u]) => [file, u.imports])));
  return [
    `routes ${result.routes}`,
    ...result.missing.map((m) => `${m.kind} ${m.method} ${m.path.text} ${m.file}:${m.line}`),
    ...result.unused.map((u) => `unused ${u.route.method} ${u.route.path.text}`),
  ].sort();
}

test("NestJS: controllers, method decorators and the global prefix", async () => {
  assert.deepEqual(await crossStack({
    "server/main.ts": `const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix("api");\n`,
    "server/articles.controller.ts": `@ApiTags("articles")
@Controller("articles")
export class ArticlesController {
  @Get() findAll() {}
  @Get(":slug") findOne(@Param("slug") slug: string) {}
  @Delete(":slug") remove() {}
}
`,
    "web/api.ts": `export const all = () => fetch("/api/articles");\nexport const one = (s: string) => fetch(\`/api/articles/\${s}\`);\nexport const bad = () => fetch("/api/article");\n`,
  }), ["missing-route GET /api/article web/api.ts:3", "routes 3", "unused DELETE /api/articles/:slug"]);
});

test("Koa chains, Hono sub-apps and Fastify plugins with a prefix", async () => {
  assert.deepEqual(await crossStack({
    "koa.js": `const Router = require("@koa/router");
const router = new Router({ prefix: "/koa" });
router.get("/", list).get("/post/:id", show).post("/post", create);
app.use(router.routes());
`,
    "hono.ts": `const app = new Hono().basePath("/hono");\nconst book = new Hono();\nbook.get("/:id", (c) => c.text("x"));\napp.route("/book", book);\n`,
    "fastify.js": `import users from "./users.js";\nconst app = Fastify();\napp.register(users, { prefix: "/fy" });\napp.route({ method: ["GET", "HEAD"], url: "/fy/health", handler });\n`,
    "users.js": `export default async function (fastify) {\n  fastify.get("/users", async () => []);\n}\n`,
    "web/calls.js": `fetch("/koa");\nfetch("/koa/post/1");\nfetch("/koa/post", { method: "POST" });\nfetch("/hono/book/9");\nfetch("/fy/users");\nfetch("/fy/health");\n`,
  }), ["routes 7"]); // HEAD /fy/health isn't called, but health checks come from outside
});

test("Django and DRF: include() prefixes, regex and path() routes, router.register", async () => {
  assert.deepEqual(await crossStack({
    "proj/urls.py": `from django.urls import include, path\nurlpatterns = [\n    path("admin/", admin.site.urls),\n    path("api/", include("apps.blog.urls")),\n]\n`,
    "apps/blog/urls.py": `from rest_framework.routers import DefaultRouter
router = DefaultRouter()
router.register(r"posts", PostViewSet)
urlpatterns = [
    path("", include(router.urls)),
    re_path(r"^posts/(?P<slug>[-\\w]+)/like/?$", LikeView.as_view()),
    path("tags/<int:pk>/", TagView.as_view()),
]
`,
    "web/calls.js": `fetch("/api/posts");\nfetch("/api/posts/7");\nfetch("/api/posts/hello/like", { method: "POST" });\nfetch("/api/tag/3");\n`,
  }), ["missing-route GET /api/tag/3 web/calls.js:4", "routes 4", "unused ALL /api/tags/<int:pk>"]);
});

test("frontend: client base URLs from another file, Vite's proxy rewrite, superagent, generated clients", async () => {
  assert.deepEqual(await crossStack({
    "server/app.js": `const app = express();\napp.get("/users/:id", h);\napp.get("/orders", h);\napp.get("/items", h);\napp.post("/login", h);\n`,
    "web/vite.config.ts": `export default defineConfig({ server: { proxy: { "/api": { target: "http://localhost:3000", rewrite: (p) => p.replace(/^\\/api/, "") } } } });\n`,
    "web/src/http.ts": `import axios from "axios";\nexport const http = axios.create({ baseURL: "/api" });\n`,
    "web/src/users.ts": `import { http } from "./http";\nexport const user = (id: string) => http.get(\`/users/\${id}\`);\nexport const gone = () => http.get("/user/me");\n`,
    "web/src/orders.ts": `export const orders = () => fetch("/api/orders");\nexport const items = () => superagent.get("http://localhost:3000/items");\n`,
    "web/src/client/sdk.gen.ts": `export const login = () => __request(OpenAPI, { method: "POST", url: "/login" });\n`,
    "app/src/api.ts": `import { create } from "apisauce";\nconst api = create({ baseURL: "https://api.example.com" });\nexport const x = () => api.get("anything");\n`,
    "web/src/notes.ts": `const cache = new Map();\nexport const note = () => cache.get("/users/1");\n`,
  }), ["missing-route GET /user/me web/src/users.ts:3", "routes 4"]);
});

test("Express: routers mounted in a loop over a list of { path, route }", async () => {
  assert.deepEqual(await crossStack({
    "src/app.js": `const routes = require("./routes");\nconst app = express();\napp.use("/v1", routes);\n`,
    "src/routes/index.js": `const authRoute = require("./auth");
const userRoute = require("./user");
const router = express.Router();
const defaultRoutes = [
  { path: "/auth", route: authRoute },
  { path: "/users", route: userRoute },
];
defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});
const adminRoutes = [{ path: "/admin", route: require("./admin") }];
for (const r of adminRoutes) router.use(r.path, r.route);
module.exports = router;
`,
    "src/routes/auth.js": `const router = express.Router();\nrouter.post("/login", login);\nmodule.exports = router;\n`,
    "src/routes/user.js": `const router = express.Router();\nrouter.route("/:userId").get(show).delete(remove);\nmodule.exports = router;\n`,
    "src/routes/admin.js": `const router = express.Router();\nrouter.get("/stats", stats);\nmodule.exports = router;\n`,
    "web/api.js": `fetch("/v1/auth/login", { method: "POST" });\nfetch(\`/v1/users/\${id}\`);\nfetch("/v1/admin/stats");\nfetch("/v1/user/1");\n`,
  }), ["missing-route GET /v1/user/1 web/api.js:4", "routes 4", "unused DELETE /v1/users/:userId"]);
});

test("Flask: blueprints imported with `from . import auth` inside an app factory", async () => {
  assert.deepEqual(await crossStack({
    "flaskr/__init__.py": `from flask import Flask

def create_app():
    app = Flask(__name__)
    from . import auth
    app.register_blueprint(auth.bp)
    return app
`,
    "flaskr/auth.py": `from flask import Blueprint
bp = Blueprint("auth", __name__, url_prefix="/auth")

@bp.route("/login", methods=["POST"])
def login(): ...

@bp.route("/logout")
def logout(): ...
`,
    "web/app.js": `fetch("/auth/login", { method: "POST" });\nfetch("/auth/signout");\n`,
  }), ["missing-route GET /auth/signout web/app.js:2", "routes 2", "unused GET /auth/logout"]);
});

test("Fastify: @fastify/autoload makes each folder under routes/ a prefix", async () => {
  assert.deepEqual(await crossStack({
    "src/app.ts": `import fastifyAutoload from "@fastify/autoload";
export default async function app(fastify, opts) {
  fastify.register(fastifyAutoload, { dir: path.join(import.meta.dirname, "routes"), autoHooks: true, options: { ...opts } });
  fastify.register(fastifyAutoload, { dir: path.join(import.meta.dirname, "admin"), options: { prefix: "/admin" } });
}
`,
    "src/routes/home.ts": `export default async function (fastify) {\n  fastify.get("/", home);\n}\n`,
    "src/routes/api/tasks/index.ts": `export default async function (fastify) {\n  fastify.get("/:id", show);\n  fastify.post("/:id/assign", assign);\n}\n`,
    "src/admin/stats.ts": `export default async function (fastify) {\n  fastify.get("/stats", stats);\n}\n`,
    "web/api.ts": `fetch(\`/api/tasks/\${id}\`);\nfetch("/admin/stats");\nfetch("/api/task/1");\n`,
  }), ["missing-route GET /api/task/1 web/api.ts:3", "routes 4", "unused POST /api/tasks/:id/assign"]);
});
