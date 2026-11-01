import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRepo } from "./helpers.ts";
import { buildIndex } from "../src/index/repo.ts";
import { findUnusedFiles } from "../src/rules/codebase/unusedFiles.ts";

async function unusedIn(files: Record<string, string>): Promise<string[]> {
  const root = await makeRepo(files);
  return (await findUnusedFiles(await buildIndex(root))).map((f) => `${f.confidence} ${f.file}`);
}

test("flags files nothing uses; one-off scripts only as maybe", async () => {
  assert.deepEqual(await unusedIn({
    "src/main.ts": 'import { a } from "./used";\n',
    "src/used.ts": "export const a = 1;\n",
    "src/old_version.ts": "export const a = 2;\n",
    "experiment.py": 'def go():\n    pass\n\nif __name__ == "__main__":\n    go()\n',
  }), ["maybe experiment.py", "likely src/old_version.ts"]);
});

test("does not flag files reached in other ways", async () => {
  assert.deepEqual(await unusedIn({
    "package.json": JSON.stringify({ dependencies: { next: "1" } }),
    "src/main.tsx": 'import { u } from "./util.js";\nimport { s } from "./auth.service";\nimport Button from "./components/Button";\nconst P = () => import("./pages/Lazy");\n',
    "src/util.ts": "export const u = 1;\n",
    "src/auth.service.ts": "export const s = 1;\n",
    "src/components/Button/index.tsx": "export default () => null;\n",
    "src/pages/Lazy.tsx": "export default () => null;\n",
    "pages/about.tsx": "export default () => null;\n",
    "vite.config.ts": "export default {};\n",
    "src/types.d.ts": "declare const x: number;\n",
    "run.py": 'import uvicorn\nuvicorn.run("app.main:app")\n',
    "app/main.py": "app = None\n",
    "agents/__init__.py": "from . import chatbot\n",
    "agents/chatbot.py": "def chat():\n    pass\n",
    "agents/planner.py": "def plan():\n    pass\n",
    "worker.py": "from agents.planner import plan\n",
    "index.html": '<script src="/static/js/chat.js"></script>\n',
    "static/js/chat.js": "console.info(1);\n",
    "tests/test_plan.py": "def test_plan():\n    pass\n",
    "backend/app/alembic/versions/e2412789c190_initialize_models.py": "def upgrade():\n    pass\n",
  }), ["likely worker.py"]); // worker.py itself: imports others, but nothing reaches it
});

test("Python apps and scripts, also when scanning the folder above the project", async () => {
  assert.deepEqual(await unusedIn({
    "proj/README.md": "Run: uvicorn api:app --reload\n",
    "proj/api.py": "from fastapi import FastAPI\napp = FastAPI()\n", // started by uvicorn
    "proj/server2.py": "from flask import Flask\napp = Flask(__name__)\n", // a web app
    "proj/demo.py": "import gradio as gr\ngr.ChatInterface(lambda m, h: m).launch()\n", // runs on its own
    "proj/blog.py": "def write():\n    pass\n", // "blog" is a common word: must still be caught
    "proj/notes.md": "This blog explains the design.\n",
  }), ["likely proj/blog.py", "maybe proj/demo.py"]);
});

test("Fastify autoload: plugin and route files are loaded by folder, not imported", async () => {
  const index = await buildIndex(await makeRepo({
    "package.json": JSON.stringify({ dependencies: { fastify: "5.0.0", "@fastify/autoload": "6.0.0" } }),
    "src/app.ts": `import AutoLoad from "@fastify/autoload";\nexport default async function app(f) { f.register(AutoLoad, { dir: "plugins" }); }\n`,
    "src/plugins/session.ts": "export default async function session() {}\n",
    "src/routes/api/autohooks.ts": "export default async function hooks() {}\n",
    "src/lib/old.ts": "export const old = 1;\n",
  }));
  assert.deepEqual((await findUnusedFiles(index)).map((f) => f.file), ["src/lib/old.ts"]);
});
