import { javascript } from "./javascript.ts";
import type { LanguageSupport } from "./types.ts";

// Astro: an .astro file is TypeScript (the --- frontmatter and <script> blocks) plus an HTML
// template. Attentry reads it as TypeScript with the template blanked out, line for line, so
// every line number still matches the real file.

const RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in",
  "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "let", "static", "implements", "interface", "package",
  "private", "protected", "public", "as", "of", "undefined",
]);

const blank = (line: string) => line.replace(/\S/g, " ");

// A <script> whose body is JavaScript: not src=, not self-closing, not JSON-LD or a template.
const JS_SCRIPT = /<script\b(?![^>]*\bsrc=)(?![^>]*\btype=["'](?!module|text\/javascript)[^"']*["'])[^>]*(?<!\/)>/i;

// Names the template uses: {formatDate(post.date)} and <Card />. They're uses of what the
// frontmatter defines or imports, so they must count, or those look dead.
function templateNames(template: string): string[] {
  const names = new Set<string>();
  for (const tag of template.matchAll(/<([A-Z][\w$]*)/g)) names.add(tag[1]!);
  let depth = 0;
  let expression = "";
  for (const ch of template) {
    if (ch === "{") depth++;
    if (depth > 0) expression += ch;
    if (ch === "}" && depth > 0 && --depth === 0) expression += " ";
  }
  const code = expression
    .replace(/\/\*[\s\S]*?\*\/|(?<![:"'\w])\/\/[^\n]*/g, " ") // comments first ("the form's id"), not https://
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, " "); // strings aren't names
  // Not attribute names (title={...}), properties (post.title) or HTML tags (<a>).
  for (const m of code.matchAll(/(?<![\w$.<\/])[A-Za-z_$][\w$]*(?![\w$]|\s*=[^=>])/g)) if (!RESERVED.has(m[0])) names.add(m[0]);
  return [...names];
}

export function astroToTs(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  const template: string[] = [];
  let inFrontmatter = false;
  let frontmatterDone = false;
  let inScript = false;
  for (const line of lines) {
    if (!frontmatterDone && line.trim() === "---") {
      inFrontmatter = !inFrontmatter;
      if (!inFrontmatter) frontmatterDone = true;
      out.push(blank(line));
      continue;
    }
    if (inFrontmatter) {
      out.push(line);
      continue;
    }
    // <script> blocks are code; <script> tags themselves and everything else are template.
    if (inScript && /<\/script>/i.test(line)) {
      inScript = false;
      out.push(blank(line));
    } else if (inScript) {
      out.push(line);
    } else {
      if (JS_SCRIPT.test(line) && !/<\/script>/i.test(line)) inScript = true;
      template.push(line);
      out.push(blank(line));
    }
  }
  const used = templateNames(template.join("\n"));
  // After the last real line, so line numbers don't move.
  if (used.length) out.push(`void [${used.join(", ")}];`);
  return out.join("\n");
}

export const astro: LanguageSupport = {
  ...javascript,
  label: "Astro",
  grammars: {
    ".astro": { id: "astro", wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm", preprocess: astroToTs },
  },
};
