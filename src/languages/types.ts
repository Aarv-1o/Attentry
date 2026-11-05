import type { Node } from "web-tree-sitter";
import type { FunctionInfo } from "../index/functions.ts";
import type { ImportInfo } from "../index/usage.ts";
import type { FileApi } from "../rules/crossStack/types.ts";

export type LanguageId = "javascript" | "typescript" | "tsx" | "python" | "astro";

// Everything Attentry needs to know about one language family. Adding a language
// (Java, Go, Astro...) means writing one of these and registering it in index.ts.
export interface LanguageSupport {
  family: string; // dialects that share code rules, e.g. JS, TS and TSX are all "js"
  label: string; // for people: "JS/TS", "Python"
  // By file extension. `preprocess` turns a file into source the grammar can read (Astro's
  // template is blanked out); it must keep every line where it is.
  grammars: Record<string, { id: LanguageId; wasm: string; preprocess?: (source: string) => string }>;
  extractFunctions(root: Node, file: string, id: LanguageId): FunctionInfo[];
  extractImports(root: Node): ImportInfo[];
  // The module names an import can point at: "./util.js" -> ["util"], "agents.planner" -> ["planner"].
  importedModules(imp: ImportInfo): string[];
  // Files that run on their own: "app" (a web server: never unused) or "script" (maybe a leftover).
  entryKind(text: string): "app" | "script" | undefined;
  unusedExportReason: string; // what "exported but unused" means in this language
  // Browser code: an error that's only logged there is one the user never sees.
  runsInBrowser(file: string, imports: string[]): boolean;
  // The HTTP routes this file serves and the API calls it makes, for the cross-stack check.
  extractApi(root: Node, file: string): FileApi;
  syntax: Syntax;
}

// The words line rules need, so the rules themselves work for any language.
export interface Syntax {
  catchClause: string; // "catch_clause", "except_clause"
  catchBody(clause: Node): Node | undefined;
  catchVariable(clause: Node): string | undefined; // the `e` in catch (e) / except X as e
  catchType(clause: Node): string | undefined; // the `ValueError` in except ValueError: (none in JS)
  throwStatement: string; // "throw_statement", "raise_statement"
  emptyStatement: string | undefined; // Python's "pass"
  nesting: string[]; // statements that add a level of nesting
  functionTypes: string[]; // function and lambda nodes: nesting and names stop at them
  callType: string; // "call_expression", "call"
  logCall: RegExp; // a statement that only logs: console.error(...), print(...)
  commentText(comment: string): string; // the words of a comment, without // or #
  looksLikeCode: RegExp; // a comment that is really commented-out code
}
