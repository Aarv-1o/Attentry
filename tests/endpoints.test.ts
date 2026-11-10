import assert from "node:assert/strict";
import { test } from "node:test";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

async function security(files: Record<string, string>): Promise<string[]> {
  const result = await scanRepo(await makeRepo(files));
  return result.security.map((f) => `${f.rule} ${f.confidence} ${f.file}:${f.line}`).sort();
}

const PKG = JSON.stringify({ dependencies: { express: "^4.21.0" } });

test("Express: missing auth, admin without role, IDOR, login without rate limit; guards from mounts and use()", async () => {
  const found = await security({
    "package.json": PKG,
    "server/index.js": `import express from "express";
import orders from "./orders.js";
import admin from "./admin.js";
const app = express();
app.use("/api/orders", requireAuth, orders);
app.use("/api/admin", requireAuth, admin);
app.post("/api/login", login);
app.post("/api/upload", (req, res) => res.json(save(req.file)));
app.post("/api/webhooks/stripe", (req, res) => res.send());
`,
    "server/orders.js": `import { Router } from "express";
const router = Router();
router.get("/mine", async (req, res) => res.json(await Order.find({ userId: req.user.id })));
router.get("/:id", async (req, res) => res.json(await Order.findById(req.params.id)));
router.get("/:id/safe", async (req, res) => res.json(await Order.findOne({ _id: req.params.id, userId: req.user.id })));
export default router;
`,
    "server/admin.js": `import { Router } from "express";
const router = Router();
router.delete("/users/:id", async (req, res) => res.json(await User.findByIdAndDelete(req.params.id)));
export default router;
`,
  });
  assert.deepEqual(found, [
    "admin-without-role likely server/admin.js:3",
    "auth-without-rate-limit likely server/index.js:7",
    "missing-ownership-check likely server/orders.js:4",
    "unauthenticated-route likely server/index.js:8",
  ]);
});

test("does not flag: inline token checks, role guards, rate limiters, explicitly public routes, sign-up", async () => {
  assert.deepEqual(await security({
    "package.json": PKG,
    "server/index.js": `import express from "express";
const app = express();
app.use("/api/admin", requireAuth, requireRole("admin"), (req, res) => res.send());
app.get("/api/me", async (req, res) => { const user = jwt.verify(req.headers.authorization, KEY); res.json(user); });
app.post("/api/login", loginLimiter, login);
app.post("/api/users", signupLimiter, createUser);
app.post("/api/items", requireAuth, createItem);
app.get("/api/admin/stats", requireAuth, isAdmin, async (req, res) => res.json(await Stat.findById(req.params.id)));
`,
  }), []);
});

test("auth set up app-wide in a way that can't be followed (Flask before_request): a route with no check of its own is 'maybe'", async () => {
  assert.deepEqual(await security({
    "requirements.txt": "flask\nflask-login\n",
    "app.py": `from flask import Flask, request, abort
from flask_login import login_required, current_user
app = Flask(__name__)

@app.before_request
def require_login():
    if request.endpoint != "login" and not current_user.is_authenticated:
        abort(401)

@app.route("/notes", methods=["POST"])
@login_required
def create():
    return save(request.json)

@app.route("/notes/<int:note_id>", methods=["DELETE"])
def remove(note_id):
    return delete(note_id)
`,
  }), ["unauthenticated-route maybe app.py:15"]);
});

test("NestJS forRoutes, FastAPI dependencies, Django permission classes count as guards", async () => {
  assert.deepEqual(await security({
    "src/main.ts": `import { AppModule } from "./app.module";\nconst app = await NestFactory.create(AppModule);\napp.setGlobalPrefix("api");\n`,
    "src/app.module.ts": `import { UserModule } from "./user.module";\nimport { UserController } from "./user.controller";\nexport const AppModule = [UserModule, UserController];\n`,
    "src/user.module.ts": `export class UserModule { configure(consumer) { consumer.apply(AuthMiddleware).forRoutes({ path: "user", method: RequestMethod.PUT }); } }\n`,
    "src/user.controller.ts": `@Controller()\nexport class UserController {\n  @Put("user") update(@Body() b) {}\n  @Delete("users/:slug") remove(@Param() p) {}\n}\n`,
  }), ["unauthenticated-route likely src/user.controller.ts:4"]);
  assert.deepEqual(await security({
    "app/api.py": `from fastapi import APIRouter, Depends
router = APIRouter()
@router.get("/items/{id}")
def read(id: int, current_user: CurrentUser):
    return session.get(Item, id)
@router.post("/items", dependencies=[Depends(get_current_active_superuser)])
def create(item: ItemIn):
    return item
`,
  }), [], "FastAPI routes are guarded; with no other handler scoping by user, an IDOR would only be a hint");
});

test("Express: a rate limit written inside the login handler counts (what Claude wrote in the final test)", async () => {
  const found = await security({
    "package.json": PKG,
    "server.js": `import express from "express";
const app = express();
app.post("/login", (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: "Too many attempts" });
  res.json({ token: sign(req.body) });
});
app.post("/signup", (req, res) => res.json(createUser(req.body)));
`,
  });
  assert.deepEqual(found.filter((f) => f.startsWith("auth-without-rate-limit")), ["auth-without-rate-limit likely server.js:7"]);
});
