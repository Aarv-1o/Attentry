import { posix } from "node:path";
import { isTestFile } from "../../index/files.ts";
import type { RepoIndex } from "../../index/repo.ts";
import { escapeRegex, readTexts } from "../../index/texts.ts";
import { supportFor } from "../../languages/index.ts";
import { detectLanguage } from "../../parse/parse.ts";
import type { Confidence } from "../confidence.ts";

export interface UnusedFile {
  file: string;
  lines: number;
  confidence: Confidence; // never "sure": deleting a file is not a call to make automatically
  reason: string;
}

// Files that run on their own or are loaded by tools, so nothing needs to import them.
const ENTRY = new RegExp(
  [
    String.raw`(^|/)(main|index|app|server|run|cli|manage|setup|wsgi|asgi|conftest|__init__|__main__)\.\w+$`,
    String.raw`\.config\.\w+$`, String.raw`(^|/)\.\w+rc\.\w+$`, String.raw`\.d\.ts$`,
    // Migrations (Alembic keeps them in versions/) are loaded by the migration tool.
    String.raw`(^|/)(migrations|scripts|bin)/`, String.raw`(^|/)alembic/versions/`,
  ].join("|"),
);
// With file-based routing, pages are loaded by the framework.
const ROUTING_FRAMEWORKS = ["next", "nuxt", "@remix-run/react", "@sveltejs/kit", "astro", "expo-router"];
const ROUTED = /(^|\/)(pages|app|routes)\//;
// @fastify/autoload loads every file in its folders (plugins/, routes/, and autohooks files).
const AUTOLOADED = /(^|\/)(plugins|routes)\//;


const stemOf = (file: string) => posix.basename(file).replace(/\.[^.]+$/, "");
// An index file is imported by its folder name: "./components/Button" -> components/Button/index.tsx.
const importNameOf = (file: string) => (stemOf(file) === "index" ? posix.basename(posix.dirname(file)) : stemOf(file));

export async function findUnusedFiles(index: RepoIndex): Promise<UnusedFile[]> {
  // Every name an import could point at, and which files import it.
  const importers = new Map<string, Set<string>>();
  const note = (name: string, by: string) => importers.set(name, new Set([...(importers.get(name) ?? []), by]));
  for (const [file, usage] of index.usage) {
    const language = detectLanguage(file);
    if (!language) continue;
    for (const imp of usage.imports) for (const name of supportFor(language).importedModules(imp)) note(name, file);
  }

  const texts = await readTexts(index.root, index.allFiles);
  const rootManifest = texts.get("package.json") ?? "";
  const routed = ROUTING_FRAMEWORKS.some((fw) => rootManifest.includes(`"${fw}"`));
  const autoloaded = rootManifest.includes('"@fastify/autoload"');

  // Referenced by path in HTML, scripts, Dockerfiles, notebooks, or "api:app" for uvicorn.
  // Only distinctive forms count: a bare "api" or "blog" appears in almost any text.
  const mentionedElsewhere = (file: string): boolean => {
    const segments = file.replace(/\.[^.]+$/, "").split("/");
    const stem = segments.at(-1)!;
    const lastTwo = segments.slice(-2);
    const needles = [posix.basename(file)];
    if (lastTwo.length === 2) needles.push(lastTwo.join("/"), lastTwo.join("."));
    const appRef = new RegExp(`(^|[\\s"'=.])${escapeRegex(stem)}:[A-Za-z_]`, "m"); // uvicorn/gunicorn "module:app"
    for (const [other, text] of texts) {
      if (other !== file && (needles.some((n) => text.includes(n)) || appRef.test(text))) return true;
    }
    return false;
  };

  const unused: UnusedFile[] = [];
  for (const file of index.files) {
    if (ENTRY.test(file) || isTestFile(file) || (routed && ROUTED.test(file)) || (autoloaded && AUTOLOADED.test(file))) continue;
    const by = importers.get(importNameOf(file));
    if (by && [...by].some((f) => f !== file)) continue;
    if (mentionedElsewhere(file)) continue;
    const text = texts.get(file) ?? "";
    const lines = text.split("\n").length;
    const language = detectLanguage(file);
    const entry = language ? supportFor(language).entryKind(text) : undefined;
    if (entry === "app") continue; // a web server, started by uvicorn/flask/gunicorn
    // A runnable script may be run by hand, but agents leave a lot of one-off experiment scripts behind.
    if (entry === "script") {
      unused.push({ file, lines, confidence: "maybe", reason: "A runnable script nothing refers to. Still needed?" });
    } else {
      unused.push({ file, lines, confidence: "likely", reason: "Nothing imports or mentions this file." });
    }
  }
  return unused;
}
