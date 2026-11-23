import type { Node } from "web-tree-sitter";
import type { FunctionInfo } from "../index/functions.ts";
import type { ImportInfo } from "../index/usage.ts";
import { commonInfo, descendants, enclosingClass, valueReferences } from "./nodes.ts";
import { extractPythonApi } from "./pythonApi.ts";
import { extractPythonTestCalls } from "./pythonTestCalls.ts";
import type { LanguageSupport, Syntax } from "./types.ts";

function paramsOf(node: Node): string[] {
  const params = node.childForFieldName("parameters");
  if (!params) return [];
  // keyword_separator is the bare `*`, positional_separator the bare `/`: markers, not params.
  return params.namedChildren
    .filter((p) => !["comment", "keyword_separator", "positional_separator"].includes(p.type))
    .map((p) => {
      if (p.type === "identifier" || p.type.endsWith("splat_pattern")) return p.text; // keeps *args, **kwargs
      return (p.childForFieldName("name") ?? p.namedChildren[0] ?? p).text;
    });
}

const MAIN_BLOCK = /__name__\s*==\s*["']__main__["']/;
const TOP_LEVEL_CALL = /^[A-Za-z_][\w.]*\(/m; // e.g. demo.launch() or main()
const WEB_APP = /^\w+\s*=\s*(FastAPI|Flask|Starlette|Quart|Sanic)\(/m;

const syntax: Syntax = {
  catchClause: "except_clause",
  catchBody: (clause) => clause.namedChildren.find((c) => c.type === "block"),
  catchVariable: (clause) => /\bas\s+(\w+)\s*:/.exec(clause.text.split("\n")[0] ?? "")?.[1],
  catchType: (clause) => /^except\s+(.+?)(\s+as\s+\w+)?\s*:/.exec(clause.text.split("\n")[0] ?? "")?.[1],
  throwStatement: "raise_statement",
  emptyStatement: "pass_statement",
  nesting: ["if_statement", "for_statement", "while_statement", "try_statement", "with_statement", "match_statement"],
  functionTypes: ["function_definition", "lambda"],
  callType: "call",
  logCall: /^(print|logging\.\w+|logger\.\w+|log\.\w+|traceback\.print_exc)\(/,
  commentText: (comment) => comment.replace(/^#+/, "").trim(),
  looksLikeCode: /^(import |from \w[\w.]* import |def |return\b|print\(|if .+:$|for .+:$|[\w.[\]'"]+\(.*\)$|[\w.[\]]+ ?= ?[^=].*$)/,
};

export const python: LanguageSupport = {
  family: "python",
  label: "Python",
  grammars: { ".py": { id: "python", wasm: "tree-sitter-python/tree-sitter-python.wasm" } },

  extractFunctions(root, file, id) {
    const found: FunctionInfo[] = [];
    const valueRefs = valueReferences(root, syntax);
    for (const node of descendants(root)) {
      if (node.type !== "function_definition") continue;
      const name = node.childForFieldName("name")?.text;
      if (!name) continue;
      const className = enclosingClass(node, "class_definition");
      // Compare by type: web-tree-sitter hands out a new Node object on every access.
      const decorated = node.parent?.type === "decorated_definition";
      const holder = decorated ? node.parent?.parent : node.parent;
      found.push({
        ...commonInfo(node, { name, file, language: id, syntax, params: paramsOf(node), valueRefs }),
        className,
        kind: className ? "method" : "function",
        decorated,
        defaultExport: false,
        exported: holder?.type === "module" && !name.startsWith("_"), // a public top-level name
      });
    }
    return found;
  },

  extractImports(root) {
    const found: ImportInfo[] = [];
    for (const node of descendants(root)) {
      const line = node.startPosition.row + 1;
      if (node.type === "import_statement") {
        // import a.b, c as d
        for (const child of node.namedChildren) {
          const name = child.type === "aliased_import" ? child.childForFieldName("name") : child;
          // `import a.b as c` binds c to the module; plain `import a.b` binds only `a`.
          const alias = child.type === "aliased_import" ? child.childForFieldName("alias")?.text : name?.text;
          if (name) found.push({ source: name.text, names: [], line, bound: alias && !alias.includes(".") ? { [alias]: "*" } : {} });
        }
      } else if (node.type === "import_from_statement") {
        // from .x import a, b as c
        const module = node.childForFieldName("module_name");
        if (!module) continue;
        const parts = node.childrenForFieldName("name");
        const names = parts.map((n) => (n.type === "aliased_import" ? n.childForFieldName("name") ?? n : n).text);
        const bound = Object.fromEntries(parts.map((n, i) => [(n.type === "aliased_import" ? n.childForFieldName("alias")?.text : undefined) ?? names[i]!, names[i]!]));
        found.push({ source: module.text, names, line, bound });
      }
    }
    return found;
  },

  // "agents.planner" -> planner. Imported names may be modules too (`from . import chatbot`),
  // so they count: better to miss a dead file than to call a used one dead.
  importedModules(imp) {
    const last = imp.source.split(".").filter(Boolean).pop();
    return [...(last ? [last] : []), ...imp.names];
  },

  entryKind(text) {
    if (WEB_APP.test(text)) return "app";
    return MAIN_BLOCK.test(text) || TOP_LEVEL_CALL.test(text) ? "script" : undefined;
  },
  unusedExportReason: "Nothing uses it.",
  runsInBrowser: () => false,
  extractApi: extractPythonApi,
  extractTestCalls: extractPythonTestCalls,

  syntax,
};
