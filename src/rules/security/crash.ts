import type { Node } from "web-tree-sitter";
import { collector, walk, type FileContext, type LineFinding } from "../line/types.ts";

// What takes the whole server down, or a page with it: code that assumes the happy path
// ("error handling that assumes happy paths", a top crash pattern in AI code).

const ROUTE_METHOD = /^(app|router|server|\w+Router|api)\.(get|post|put|patch|delete|all|use)$/;
const FUNCTIONS = new Set(["arrow_function", "function_expression", "function_declaration", "method_definition", "function_definition", "lambda", "function"]);
// Not readFileSync or process.argv: a script or a server's startup that stops loudly on a bad
// file is doing the right thing, and no request fails with it.
const UNTRUSTED_JSON = /localStorage|sessionStorage|\breq\.|\brequest\.|event\.data|message\.data|\.data\b|searchParams|cookie|\bbody\b|text\(\)|ws\b|socket/;

// Node objects are fresh wrappers on each lookup: compare by id, never with ===.
const same = (a: Node | null, b: Node | null) => !!a && !!b && a.id === b.id;

const insideTry = (node: Node, stop: Node | null) => {
  for (let p = node.parent; p && !same(p, stop); p = p.parent) {
    if (p.type === "try_statement") return true;
    if (FUNCTIONS.has(p.type)) return false;
  }
  return false;
};

function enclosingFunction(node: Node): Node | null {
  for (let p = node.parent; p; p = p.parent) if (FUNCTIONS.has(p.type)) return p;
  return null;
}

export function crashRules({ parsed, file, frontend }: FileContext): LineFinding[] {
  const python = parsed.language === "python";
  const { found, add } = collector(file);
  for (const node of walk(parsed.tree.rootNode)) {
    if (python) {
      // sys.exit() in a request handler stops the whole server.
      if (node.type === "call" && /^(sys\.exit|exit|quit|os\._exit)$/.test(node.childForFieldName("function")?.text ?? "")) {
        const fn = enclosingFunction(node);
        if (fn?.parent?.type === "decorated_definition" && /@\w+\.(get|post|put|patch|delete|route)\(/.test(fn.parent.text.slice(0, 300))) {
          add(node, "exit-in-handler", "likely", "sys.exit() in a request handler stops the whole server");
        }
      }
      continue;
    }
    if (node.type !== "call_expression") continue;
    const callee = node.childForFieldName("function")?.text ?? "";
    // Express 4 doesn't catch a rejected promise from an async handler: the request hangs and
    // Node (15+) exits on the unhandled rejection. Express 5 handles it (filtered out later).
    if (ROUTE_METHOD.test(callee)) {
      const handler = node.childForFieldName("arguments")?.namedChildren.at(-1);
      if (handler && FUNCTIONS.has(handler.type) && /^async\b/.test(handler.text)) {
        const awaited = [...walk(handler)].find((n) => n.type === "await_expression" && same(enclosingFunction(n), handler) && !insideTry(n, handler));
        if (awaited) add(handler, "async-handler-no-catch", "likely", `An error in this async ${callee.split(".")[1]!.toUpperCase()} handler isn't caught: on Express 4 one failed await can crash the whole server`);
      }
      continue;
    }
    // JSON.parse on data from outside throws on anything malformed.
    if (callee === "JSON.parse") {
      const arg = node.childForFieldName("arguments")?.namedChildren[0];
      if (!arg || arg.type === "string" || arg.type === "template_string" || insideTry(node, null)) continue;
      const outside = UNTRUSTED_JSON.test(arg.text);
      // localStorage holds the app's own data (old formats, manual edits): a hint. Data from
      // requests, messages and responses can be anything.
      const own = /localStorage|sessionStorage/.test(arg.text);
      if (outside) add(node, "unguarded-json-parse", own ? "maybe" : "likely", `JSON.parse(${arg.text.slice(0, 40)}) has no try/catch: bad or missing data throws${frontend ? " and breaks the page" : " and fails the request"}`);
      continue;
    }
    // process.exit() inside a request handler kills every user's requests.
    if (callee === "process.exit") {
      for (let p = node.parent; p; p = p.parent) {
        if (p.type === "call_expression" && ROUTE_METHOD.test(p.childForFieldName("function")?.text ?? "")) {
          add(node, "exit-in-handler", "likely", "process.exit() in a request handler stops the whole server");
          break;
        }
      }
    }
  }
  return found;
}
