import type { Node } from "web-tree-sitter";
import type { ParsedFile } from "../parse/parse.ts";
import { hideSecrets } from "../rules/security/secrets.ts";

// What a function does, read from its syntax tree: the conditions it checks, what it calls,
// what it changes and what it returns. Plain-language cards are built from these facts, so
// explaining code costs no AI credits.

export interface FunctionFacts {
  file: string;
  startLine: number;
  endLine: number;
  name: string | undefined; // undefined for an anonymous handler
  params: string;
  when: string | undefined; // the condition the whole body depends on: `if (x) {...}` or a guard `if (!x) return`
  calls: string[]; // "Order.findById", "res.status().json"
  changes: { target: string; value: string }[]; // fields it sets: player.health = 100
  returns: string[];
  steps: number; // top-level statements in the body
  touches: string[]; // fields and functions it uses: two functions that share most of these do the same job
}

const FUNCTIONS = new Set(["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "function_definition"]);
// Named functions inside a function are their own functions; callbacks are part of it.
const OWN_FUNCTIONS = new Set(["function_declaration", "method_definition", "function_definition", "generator_function_declaration"]);
const CALLS = new Set(["call_expression", "call"]);
const ASSIGNMENTS = new Set(["assignment_expression", "assignment", "augmented_assignment_expression", "augmented_assignment"]);
const FIELDS = new Set(["member_expression", "attribute", "subscript_expression", "subscript"]);
// Calls that say nothing about what a function is for.
const NOISE_CALL = /^(console\.\w+|print|logger?\.\w+|.*\.(push|map|filter|forEach|then|catch|finally|toString|trim|join|split|includes|slice|length))$/;
const COMMON = new Set(["log", "push", "map", "filter", "forEach", "then", "catch", "length", "toString", "json", "status", "send", "end", "get", "set", "has", "keys", "values", "trim", "join", "split", "error", "message", "data", "id", "console", "print", "res", "req", "self", "this"]);

const clip = (text: string, max = 40) => {
  const one = hideSecrets(text.replace(/\s+/g, " ").trim());
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
// res.status(204).end -> res.status().end: the arguments don't say what it does.
// (total / 100).toFixed -> toFixed: a computed value isn't a name.
const callName = (text: string) => {
  const name = text.replace(/\((?:[^()]|\([^()]*\))*\)/g, "()").replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".");
  return name.startsWith("(") ? name.replace(/^[^.]*\./, "") : name;
};
// A call that's part of a longer chain: User.findById() in User.findById().select().lean().
const inChain = (call: Node) => !!call.parent && FIELDS.has(call.parent.type) && CALLS.has(call.parent.parent?.type ?? "");

// A value, short: { id, name } for an object, <svg> for JSX, "~HTML" or "~a text" for built
// strings ("~": already words, not code), else the code.
function returned(node: Node): string {
  const value = node.type === "parenthesized_expression" ? (node.namedChildren[0] ?? node) : node;
  if (value.type === "template_string" || (value.type === "string" && value.namedChildren.some((c) => c.type === "interpolation"))) {
    return /^[`f]?["'`]?\s*</.test(value.text) ? "~HTML" : "~a text";
  }
  if (/^jsx_(element|self_closing_element|fragment)$/.test(value.type)) return `<${/^<\s*([\w.]*)/.exec(value.text)?.[1] ?? ""}>`;
  if (value.type === "object" || value.type === "dictionary") {
    const keys = value.namedChildren.map((c) => (c.childForFieldName("key") ?? (c.type.startsWith("shorthand") ? c : null))?.text.replace(/['"]/g, "")).filter(Boolean);
    return `{ ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""} }`;
  }
  return clip(value.text);
}

function nameOf(fn: Node): string | undefined {
  const own = fn.childForFieldName("name")?.text;
  if (own) return own;
  const p = fn.parent;
  if (p?.type === "variable_declarator") return p.childForFieldName("name")?.text;
  if (p?.type === "pair") return p.childForFieldName("key")?.text.replace(/['"]/g, "");
  if (p?.type === "assignment_expression") return p.childForFieldName("left")?.text.split(".").at(-1);
  return undefined;
}

// Nodes inside a function, not inside the named functions it defines.
function* inside(node: Node): Generator<Node> {
  for (const child of node.namedChildren) {
    if (OWN_FUNCTIONS.has(child.type)) continue;
    yield child;
    yield* inside(child);
  }
}

const statementsOf = (body: Node) => body.namedChildren.filter((c) => c.type !== "comment");
const conditionOf = (ifNode: Node) => clip((ifNode.childForFieldName("condition")?.text ?? "").replace(/^\((.*)\)$/s, "$1"), 60);
const isExit = (node: Node | null) => !!node && /^(\{\s*)?(return|throw|raise|continue)\b[^;\n]*;?(\s*\})?$/.test(node.text.trim());

// The body depends on one condition: `if (c) { everything }`, or a guard first: `if (!c) return;`.
function whenOf(body: Node): string | undefined {
  const [first, ...rest] = statementsOf(body);
  if (first?.type !== "if_statement" || first.childForFieldName("alternative")) return undefined;
  if (!rest.length) return conditionOf(first);
  if (isExit(first.childForFieldName("consequence"))) return `NOT ${conditionOf(first)}`;
  return undefined;
}

// Parameter names without their types: (options?: Options<Data>) -> options.
function paramsOf(fn: Node): string {
  const list = fn.childForFieldName("parameters");
  if (!list) return clip(fn.childForFieldName("parameter")?.text ?? "", 40);
  const names = list.namedChildren.filter((p) => p.type !== "comment").map((p) => {
    const name = p.childForFieldName("pattern") ?? p.childForFieldName("name") ?? p.childForFieldName("left") ?? (p.type.startsWith("typed") ? p.namedChildren[0] : p);
    return name?.text ?? p.text;
  });
  return clip(names.join(", "), 40);
}

export function factsOf(fn: Node, file: string): FunctionFacts {
  const body = fn.childForFieldName("body");
  const calls: string[] = [];
  const changes: FunctionFacts["changes"] = [];
  const returns: string[] = [];
  const touches = new Set<string>();
  const expressionBody = body && !["statement_block", "block"].includes(body.type);
  if (expressionBody) returns.push(returned(body));
  for (const n of body && !expressionBody ? inside(body) : []) {
    if (CALLS.has(n.type) && !inChain(n)) {
      const name = callName(n.childForFieldName("function")?.text ?? "");
      if (name && name.length <= 40 && !NOISE_CALL.test(name) && !calls.includes(name)) calls.push(name);
    } else if (ASSIGNMENTS.has(n.type)) {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (left && FIELDS.has(left.type)) changes.push({ target: clip(left.text, 30), value: right ? clip(returned(right), 30) : "" });
    } else if (n.type === "return_statement" && n.namedChildren[0]) {
      returns.push(returned(n.namedChildren[0]));
    }
    if (n.type === "property_identifier" || (n.type === "identifier" && n.parent?.type === "attribute" && n.parent.childForFieldName("attribute")?.id === n.id)) {
      if (!COMMON.has(n.text)) touches.add(n.text);
    }
  }
  for (const c of calls) {
    const last = c.replace(/\(\)/g, "").split(".").at(-1)!;
    if (!COMMON.has(last)) touches.add(last);
  }
  return {
    file, startLine: fn.startPosition.row + 1, endLine: fn.endPosition.row + 1,
    name: nameOf(fn), params: paramsOf(fn),
    when: body && !expressionBody ? whenOf(body) : undefined,
    calls, changes, returns: [...new Set(returns)], steps: body && !expressionBody ? statementsOf(body).length : 1, touches: [...touches],
  };
}

export function functionFacts(parsed: ParsedFile, file: string): FunctionFacts[] {
  const found: FunctionFacts[] = [];
  const visit = (node: Node) => {
    if (FUNCTIONS.has(node.type)) found.push(factsOf(node, file));
    for (const child of node.namedChildren) visit(child);
  };
  visit(parsed.tree.rootNode);
  return found;
}
