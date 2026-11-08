import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import type { FunctionInfo } from "../index/functions.ts";
import type { ImportInfo } from "../index/usage.ts";
import { extractJsApi } from "./javascriptApi.ts";
import { commonInfo, descendants, enclosingClass, valueReferences, unquote } from "./nodes.ts";
import type { LanguageSupport, Syntax } from "./types.ts";

const FUNCTION_TYPES = new Set([
  "function_declaration", "generator_function_declaration", "function_expression",
  "arrow_function", "method_definition",
]);

// Anonymous callbacks return undefined: they can't be reused by name.
function nameOf(node: Node): string | undefined {
  const own = node.childForFieldName("name");
  if (own) return own.text;
  const parent = node.parent;
  if (parent?.type === "variable_declarator") return parent.childForFieldName("name")?.text;
  if (parent?.type === "pair") return parent.childForFieldName("key")?.text;
  return undefined;
}

function paramsOf(node: Node): string[] {
  const params = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
  if (!params) return [];
  if (params.type === "identifier") return [params.text];
  return params.namedChildren
    .filter((p) => p.type !== "comment")
    .map((p) => (p.childForFieldName("pattern") ?? p.childForFieldName("left") ?? p).text);
}

// CommonJS: `module.exports = { a, b: c }`, `module.exports = a` or `exports.a = ...`.
function commonJsExports(assignment: Node): string[] {
  const left = assignment.childForFieldName("left")?.text ?? "";
  const right = assignment.childForFieldName("right");
  if (left === "module.exports" && right?.type === "object") {
    return right.namedChildren
      .map((prop) => (prop.type === "shorthand_property_identifier" ? prop : prop.childForFieldName("key"))?.text)
      .filter((key): key is string => !!key);
  }
  if (left === "module.exports" && right?.type === "identifier") return [right.text];
  const named = /^(?:module\.)?exports\.(\w+)$/.exec(left)?.[1];
  return named ? [named] : [];
}

// Names exported via `export { a, b }`, `export default a`, or CommonJS.
function exportedNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const node of descendants(root)) {
    if (node.type === "export_specifier") names.add(node.childForFieldName("name")?.text ?? node.text);
    const value = node.type === "export_statement" ? node.childForFieldName("value") : null;
    if (value?.type === "identifier") names.add(value.text);
    if (node.type === "assignment_expression") for (const name of commonJsExports(node)) names.add(name);
  }
  return names;
}

// `export function f` or `export const f = () => …`. Not a function inside an exported one's body
// (cancelRide inside `export default function RiderApp`): that one can't be imported.
function exportAncestor(node: Node): Node | undefined {
  for (let p = node.parent, depth = 0; p && depth < 4; p = p.parent, depth++) {
    if (p.type === "export_statement") return p;
    if (p.type === "statement_block" || p.type === "class_body" || FUNCTION_TYPES.has(p.type)) return undefined;
  }
  return undefined;
}

// `export default function X` or `export default X`
function defaultExportName(root: Node): string | undefined {
  for (const node of root.namedChildren) {
    if (node.type !== "export_statement" || !node.children.some((c) => c.type === "default")) continue;
    const value = node.childForFieldName("value");
    if (value?.type === "identifier") return value.text;
  }
  return undefined;
}

// import a, { b as c }, * as d from "x"  ->  { a: "default", c: "b", d: "*" }
function importBindings(statement: Node): Record<string, string> {
  const bound: Record<string, string> = {};
  for (const part of descendants(statement)) {
    if (part.type === "import_clause") {
      const local = part.namedChildren.find((c) => c.type === "identifier");
      if (local) bound[local.text] = "default";
    } else if (part.type === "namespace_import") {
      const local = part.namedChildren.find((c) => c.type === "identifier");
      if (local) bound[local.text] = "*";
    } else if (part.type === "import_specifier") {
      const name = part.childForFieldName("name")?.text ?? part.text;
      bound[part.childForFieldName("alias")?.text ?? name] = name;
    }
  }
  return bound;
}

// const x = require("x") -> { x: "default" }; const { a, b: c } = require("x") -> { a: "a", c: "b" }
function requireBindings(call: Node): Record<string, string> {
  const pattern = call.parent?.type === "variable_declarator" ? call.parent.childForFieldName("name") : null;
  if (pattern?.type === "identifier") return { [pattern.text]: "default" };
  const bound: Record<string, string> = {};
  for (const p of pattern?.type === "object_pattern" ? pattern.namedChildren : []) {
    if (p.type === "shorthand_property_identifier_pattern") bound[p.text] = p.text;
    const key = p.type === "pair_pattern" ? p.childForFieldName("key")?.text : undefined;
    const value = p.type === "pair_pattern" ? p.childForFieldName("value") : null;
    if (key && value?.type === "identifier") bound[value.text] = key;
  }
  return bound;
}

const FRONTEND_PATH = /(^|\/)(components|pages|views|static|public|client|frontend|web|ui)\//;
const FRONTEND_IMPORT = /^(react|react-dom|vue|svelte|solid-js|preact)(\/|$)/;

const syntax: Syntax = {
  catchClause: "catch_clause",
  catchBody: (clause) => clause.childForFieldName("body") ?? undefined,
  catchVariable: (clause) => clause.childForFieldName("parameter")?.text,
  catchType: () => undefined,
  throwStatement: "throw_statement",
  emptyStatement: undefined,
  nesting: ["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "try_statement", "switch_statement"],
  functionTypes: [...FUNCTION_TYPES],
  callType: "call_expression",
  logCall: /^(console|logger|log)\.\w+\(/,
  commentText: (comment) => comment.replace(/^\/\/+|^\/\*+|\*+\/$/g, "").trim(),
  looksLikeCode:
    /^(const |let |var |if ?\(|for ?\(|return\b|import |export |await |console\.|\}|[\w.[\]'"]+\(.*\);?$|[\w.[\]]+ ?= ?[^=].*;$|<\/?[A-Z]\w*)/,
};

export const javascript: LanguageSupport = {
  family: "js",
  label: "JS/TS",
  grammars: {
    ".js": { id: "javascript", wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm" },
    ".jsx": { id: "javascript", wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm" },
    ".mjs": { id: "javascript", wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm" },
    ".cjs": { id: "javascript", wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm" },
    ".ts": { id: "typescript", wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm" },
    ".mts": { id: "typescript", wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm" },
    ".cts": { id: "typescript", wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm" },
    ".tsx": { id: "tsx", wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm" },
  },

  extractFunctions(root, file, id) {
    const exported = exportedNames(root);
    const defaultName = defaultExportName(root);
    const found: FunctionInfo[] = [];
    const valueRefs = valueReferences(root, syntax);
    for (const node of descendants(root)) {
      if (!FUNCTION_TYPES.has(node.type)) continue;
      const name = nameOf(node);
      if (!name) continue;
      const className = enclosingClass(node, "class_declaration");
      const exportNode = exportAncestor(node);
      const property = node.parent?.type === "pair" || (node.type === "method_definition" && !className);
      found.push({
        ...commonInfo(node, { name, file, language: id, syntax, params: paramsOf(node), valueRefs }),
        className,
        kind: className ? "method" : property ? "property" : "function",
        decorated: false,
        defaultExport: !!exportNode?.children.some((c) => c.type === "default") || (!className && name === defaultName),
        exported: !className && (!!exportNode || exported.has(name)),
      });
    }
    return found;
  },

  extractImports(root) {
    const found: ImportInfo[] = [];
    for (const node of descendants(root)) {
      const line = node.startPosition.row + 1;
      if (node.type === "import_statement" || (node.type === "export_statement" && node.childForFieldName("source"))) {
        const source = node.childForFieldName("source");
        if (!source) continue;
        const specifiers = [...descendants(node)].filter((n) => n.type === "import_specifier" || n.type === "export_specifier");
        const names = specifiers.map((n) => n.childForFieldName("name")?.text ?? n.text);
        found.push({ source: unquote(source), names, line, bound: node.type === "import_statement" ? importBindings(node) : {} });
      } else if (node.type === "call_expression") {
        // require("x"), require.resolve("x") and dynamic import("x")
        const fn = node.childForFieldName("function")?.text;
        const arg = node.childForFieldName("arguments")?.namedChildren[0];
        if ((fn === "require" || fn === "import" || fn === "require.resolve") && arg?.type === "string") {
          found.push({ source: unquote(arg), names: [], line, bound: fn === "require" ? requireBindings(node) : {} });
        }
      }
    }
    return found;
  },

  // "./util.js" -> util (TS ESM imports .ts files as .js), "./Card.astro" -> Card,
  // "./auth.service" keeps its dot.
  importedModules(imp) {
    const last = posix.basename(imp.source.replace(/\/+$/, "")).replace(/\.([cm]?[jt]sx?|astro|vue|svelte)$/, "");
    return last ? [last] : [];
  },

  entryKind: () => undefined,
  runsInBrowser: (file, imports) =>
    /\.[jt]sx$/.test(file) || FRONTEND_PATH.test(file) || imports.some((i) => FRONTEND_IMPORT.test(i)),
  unusedExportReason: "Exported, but nothing uses it.",
  extractApi: extractJsApi,

  syntax,
};
