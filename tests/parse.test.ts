import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { makeRepo } from "./helpers.ts";
import { detectLanguage, parseFile, parseSource, parseText } from "../src/parse/parse.ts";

test("detects languages by extension", () => {
  assert.equal(detectLanguage("a/b.js"), "javascript");
  assert.equal(detectLanguage("App.JSX"), "javascript");
  assert.equal(detectLanguage("x.mts"), "typescript");
  assert.equal(detectLanguage("Page.tsx"), "tsx");
  assert.equal(detectLanguage("main.py"), "python");
  assert.equal(detectLanguage("style.css"), undefined);
  assert.equal(detectLanguage("Makefile"), undefined);
});

test("parses each language without errors", async () => {
  const samples = {
    javascript: "export function add(a, b) { return a + b; }",
    typescript: "export const add = (a: number, b: number): number => a + b;",
    tsx: "export const Hi = ({ name }: { name: string }) => <p>{name}</p>;",
    python: "def add(a: int, b: int) -> int:\n    return a + b\n",
  } as const;
  for (const [language, source] of Object.entries(samples)) {
    const tree = await parseSource(source, language as keyof typeof samples);
    assert.equal(tree.rootNode.hasError, false, `${language} sample should parse cleanly`);
    tree.delete();
  }
});

test("parseFile reads and parses a supported file", async () => {
  const dir = await makeRepo({ "util.py": "def time_ago(ts):\n    return ts\n" });
  const parsed = await parseFile(join(dir, "util.py"));
  assert.ok(parsed);
  assert.equal(parsed.language, "python");
  assert.equal(parsed.tree.rootNode.type, "module");
  parsed.tree.delete();
});

test("parseFile skips unsupported files", async () => {
  const dir = await makeRepo({ "notes.md": "# hi" });
  assert.equal(await parseFile(join(dir, "notes.md")), undefined);
});

test("a bare & in JSX (href=\"?a=1&b=2\") doesn't stop a file being read, and lines stay put", async () => {
  const source = `export const Badge = () => (\n  <a href="https://x.com/r?utm_source=a&utm_medium=b">Tom & Jerry</a>\n);\nexport function ok(a, b) {\n  return a && b;\n}\n`;
  const parsed = (await parseText("Badge.tsx", source))!;
  try {
    assert.equal(parsed.tree.rootNode.hasError, false);
    assert.equal(parsed.source.length, source.length);
    assert.match(parsed.source, /return a && b;/, "real && untouched");
  } finally {
    parsed.tree.delete();
  }
});
