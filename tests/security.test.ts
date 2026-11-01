import assert from "node:assert/strict";
import { test } from "node:test";
import { committedEnvFiles } from "../src/rules/security/index.ts";
import { check } from "./helpers.ts";

const only = async (file: string, source: string, rules: string[]) =>
  (await check(file, source)).filter((f) => rules.includes(f.split(" ")[1]!));

test("injection: SQL, MongoDB filters, shell, eval, SSRF, redirects, paths; not parameters or fixed hosts", async () => {
  const js = `export async function h(req, res) {
  const { url, file, next, q } = req.query;
  await db.query(\`SELECT * FROM users WHERE name = '\${q}'\`);
  await db.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
  await prisma.$queryRaw\`SELECT * FROM users WHERE id = \${req.params.id}\`;
  await db.query(\`SELECT * FROM \${TABLE} LIMIT 1\`);
  await User.findOne(req.body);
  exec(\`convert \${file} out.png\`);
  const data = await fetch(url);
  await fetch(\`https://graph.facebook.com/v21.0/\${q}/messages\`);
  res.redirect(next);
  fs.readFile(path.join(UPLOADS, file));
  const item = await Item.findOne({ _id: req.params.id });
  fs.createReadStream(item.storagePath);
}
`;
  assert.deepEqual(await only("api/h.js", js, ["sql-injection", "nosql-injection", "command-injection", "ssrf", "open-redirect", "path-traversal"]), [
    "3 sql-injection likely", "7 nosql-injection likely", "8 command-injection likely", "9 ssrf likely", "11 open-redirect likely", "12 path-traversal likely",
  ]);
  const py = `@app.get("/r")
def r(q: str):
    cursor.execute(f"SELECT * FROM t WHERE name = '{q}'")
    cursor.execute("SELECT * FROM t WHERE name = %s", (q,))
    return redirect(request.args.get("next"))
`;
  assert.deepEqual(await only("app.py", py, ["sql-injection", "open-redirect"]), ["3 sql-injection likely", "5 open-redirect likely"]);
});

test("mass assignment: whole bodies saved as-is, unless a schema checked them", async () => {
  assert.deepEqual(await only("u.js", `const create = async (req, res) => { const user = new User(req.body); await Post.create(req.body); await User.create({ name: req.body.name }); };\n`, ["mass-assignment"]), ["1 mass-assignment likely", "1 mass-assignment likely"]);
  assert.deepEqual(await only("v.js", `const create = async (req, res) => { const body = schema.parse(req.body); await Post.create(req.body); };\n`, ["mass-assignment"]), []);
});

test("secrets: real key formats and secret-named values; not public keys, placeholders or env reads", async () => {
  const src = `const OPENAI = "${"sk-"}proj-abcdefghijklmnopqrstuvwx1234";
const STRIPE_SECRET_KEY = "${"sk_"}live_51HabcdefghijklmnopqrstUV";
const firebaseConfig = { apiKey: "AIzaSyA1234567890abcdefghijklmnopqrstu", authDomain: "x.firebaseapp.com" };
const publishable = "pk_live_51Habcdefghijklmnopqrstuv";
const jwtSecret = process.env.JWT_SECRET || "supersecret";
const siteKey = import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";
const apiKey = "your-api-key-here";
const DB = "mongodb+srv://admin:hunter22@cluster0.example.net/app";
const key = import.meta.env.VITE_OPENAI_API_KEY;
`;
  assert.deepEqual(await only("web/config.js", src, ["hardcoded-secret", "secret-fallback", "client-exposed-secret"]), [
    "1 hardcoded-secret likely", "2 hardcoded-secret likely", "5 secret-fallback likely", "8 hardcoded-secret likely", "9 client-exposed-secret likely",
  ]);
  // One finding per read, even inside .strip(); an empty default is "not set", so only a hint.
  const py = `JWT_SECRET = os.environ.get("JWT_SECRET", "").strip()
API_KEY = os.getenv("API_KEY", "dev-key").strip().lower()
URL = os.environ.get("SUPABASE_URL", "")
`;
  assert.deepEqual(await only("app/auth.py", py, ["secret-fallback"]), ["1 secret-fallback maybe", "2 secret-fallback likely"]);
  assert.deepEqual(await only("a.js", `const s = process.env.JWT_SECRET ?? "";\nconst t = (process.env.API_TOKEN || "abc").trim();\n`, ["secret-fallback"]), ["1 secret-fallback maybe", "2 secret-fallback likely"]);
  assert.deepEqual(committedEnvFiles([".env", "backend/.env.production", ".env.example", "src/env.ts"]).map((f) => f.file), [".env", "backend/.env.production"]);
});

test("browser and edges: XSS sinks, CORS, stack traces, debug, password hashing, JWT decode, Math.random", async () => {
  const js = `el.innerHTML = \`<b>\${msg.text}</b>\`;
icon.innerHTML = CHECK_ICON;
safe.innerHTML = DOMPurify.sanitize(html);
app.use(cors({ origin: "*", credentials: true }));
app.use((err, req, res, next) => res.status(500).json({ message: err.message, stack: err.stack }));
const hash = crypto.createHash("md5").update(password).digest("hex");
const resetToken = Math.random().toString(36).slice(2);
`;
  assert.deepEqual(await only("server.js", js, ["xss", "cors-any-origin-with-credentials", "error-leak", "weak-password-hash", "insecure-random"]), [
    "1 xss likely", "4 cors-any-origin-with-credentials likely", "5 error-leak likely", "6 weak-password-hash likely", "7 insecure-random likely",
  ]);
  assert.deepEqual(await only("App.jsx", `export const A = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n`, ["xss"]), ["1 xss likely"]);
  assert.deepEqual(await only("auth.js", `export const me = (t) => jwt.decode(t).userId;\n`, ["jwt-not-verified"]), ["1 jwt-not-verified likely"]);
  assert.deepEqual(await only("main.py", `app.run(debug=True)\n`, ["debug-mode"]), ["1 debug-mode likely"]);
});

test("crash risks: async Express handlers without try/catch, JSON.parse on outside data, exit in handlers", async () => {
  const js = `router.get("/a", async (req, res) => { const x = await load(); res.json(x); });
router.get("/b", async (req, res) => { try { res.json(await load()); } catch (e) { res.status(500).end(); } });
router.post("/c", (req, res) => { const data = JSON.parse(req.body.payload); res.json(data); });
const saved = JSON.parse(localStorage.getItem("cart"));
router.post("/d", (req, res) => { process.exit(1); });
const captions = JSON.parse(readFileSync(process.argv[2], "utf8"));
`;
  assert.deepEqual(await only("routes.js", js, ["async-handler-no-catch", "unguarded-json-parse", "exit-in-handler"]), [
    "1 async-handler-no-catch likely", "3 unguarded-json-parse likely", "4 unguarded-json-parse maybe", "5 exit-in-handler likely",
  ]);
});

test("security rules skip tests: example attacks and fake keys belong there", async () => {
  assert.deepEqual(await only("tests/auth.test.js", `const key = "${"sk_"}live_51HabcdefghijklmnopqrstUV"; eval(input);\n`, ["hardcoded-secret", "code-eval"]), []);
});

test("async handlers without try/catch only matter on Express 4", async () => {
  const { scanRepo } = await import("../src/scan/scan.ts");
  const { makeRepo } = await import("./helpers.ts");
  const files = (express: string) => ({
    "package.json": JSON.stringify({ dependencies: { express } }),
    "server.js": `import express from "express";\nconst app = express();\napp.get("/a", async (req, res) => res.json(await load()));\n`,
  });
  const rules = async (express: string) => (await scanRepo(await makeRepo(files(express)))).crashes.map((f) => f.rule);
  assert.deepEqual(await rules("^4.21.0"), ["async-handler-no-catch"]);
  assert.deepEqual(await rules("^5.1.0"), []);
});
