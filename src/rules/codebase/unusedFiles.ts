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
    // Project templates (cookiecutter, copier) run these after generating a project.
    String.raw`(^|/)hooks/(pre|post)_(gen_project|prompt)\.\w+$`,
  ].join("|"),
);
// Tools that load every file in some folders, when a package.json the file is under uses them.
const LOADED_BY: [RegExp, RegExp][] = [
  // File-based routing: pages are loaded by the framework.
  [/"(next|nuxt|@remix-run\/react|@sveltejs\/kit|astro|expo-router)"/, /(^|\/)(pages|app|routes)\//],
  // @fastify/autoload loads every file in its folders (plugins/, routes/, and autohooks files).
  [/"@fastify\/autoload"/, /(^|\/)(plugins|routes)\//],
  // react-email renders each file in emails/ (email dev, email export).
  [/"react-email"/, /(^|\/)emails\//],
];

// The package.json files above a file, joined: its own package's tools load it, a sibling's don't.
function manifestsOver(file: string, texts: Map<string, string>): string {
  const found: string[] = [];
  for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
    found.push(texts.get(posix.join(dir, "package.json")) ?? "");
    if (dir === ".") return found.join("\n");
  }
}


const stemOf = (file: string) => posix.basename(file).replace(/\.[^.]+$/, "");
// An index file is imported by its folder name: "./components/Button" -> components/Button/index.tsx.
const importNameOf = (file: string) => (stemOf(file) === "index" ? posix.basename(posix.dirname(file)) : stemOf(file));

// Referenced by path in HTML, scripts, Dockerfiles, notebooks, or "api:app" for uvicorn.
// Only distinctive forms count: a bare "api" or "blog" appears in almost any text.
function mentionsOf(file: string): (text: string) => boolean {
  const segments = file.replace(/\.[^.]+$/, "").split("/");
  const stem = segments.at(-1)!;
  const lastTwo = segments.slice(-2);
  const needles = [posix.basename(file)];
  if (lastTwo.length === 2) needles.push(lastTwo.join("/"), lastTwo.join("."));
  const appRef = new RegExp(`(^|[\\s"'=.])${escapeRegex(stem)}:[A-Za-z_]`, "m"); // uvicorn/gunicorn "module:app"
  return (text) => needles.some((n) => text.includes(n)) || appRef.test(text);
}

// Which candidates each file's text mentions, kept between scans: searching every text is most of
// a re-scan on a big repo, and after an edit only the edited file's text needs searching again.
const searched = new Map<string, { text: string; candidates: string; found: string[] }>();

function mentionedElsewhere(root: string, candidates: string[], texts: Map<string, string>): Set<string> {
  const key = candidates.join("\n");
  let tests: [string, (text: string) => boolean][] | undefined;
  const mentioned = new Set<string>();
  for (const [other, text] of texts) {
    const path = posix.join(root, other);
    let kept = searched.get(path);
    if (kept?.text !== text || kept.candidates !== key) {
      tests ??= candidates.map((file) => [file, mentionsOf(file)]);
      kept = { text, candidates: key, found: tests.filter(([, mentions]) => mentions(text)).map(([file]) => file) };
      searched.set(path, kept);
    }
    for (const file of kept.found) if (file !== other) mentioned.add(file);
  }
  return mentioned;
}

export async function findUnusedFiles(index: RepoIndex): Promise<UnusedFile[]> {
  // Every name an import could point at, and which files import it.
  const importers = new Map<string, Set<string>>();
  const note = (name: string, by: string) => (importers.get(name) ?? importers.set(name, new Set()).get(name)!).add(by);
  for (const [file, usage] of index.usage) {
    const language = detectLanguage(file);
    if (!language) continue;
    for (const imp of usage.imports) for (const name of supportFor(language).importedModules(imp)) note(name, file);
  }

  const texts = await readTexts(index.root, index.allFiles);

  // Files nothing imports: unused, unless some text mentions them.
  const candidates = index.files.filter((file) => {
    if (ENTRY.test(file) || isTestFile(file)) return false;
    if (LOADED_BY.some(([tool, folder]) => folder.test(file) && tool.test(manifestsOver(file, texts)))) return false;
    const by = importers.get(importNameOf(file));
    return !(by && [...by].some((f) => f !== file));
  });
  const mentioned = mentionedElsewhere(index.root, candidates, texts);

  const unused: UnusedFile[] = [];
  for (const file of candidates) {
    if (mentioned.has(file)) continue;
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
