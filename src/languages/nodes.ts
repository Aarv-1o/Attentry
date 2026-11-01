import type { Node } from "web-tree-sitter";
import type { FunctionInfo } from "../index/functions.ts";
import { shapeOf } from "../index/shape.ts";
import type { LanguageId, Syntax } from "./types.ts";

// Every named node under `node`, in order, walked with a cursor: each step into the parser's
// memory costs, and recursing through namedChildren made this the slowest part of a scan.
// A whole tree is walked once and shared, since every check walks every file.
const wholeTrees = new WeakMap<object, Node[]>();

function namedNodes(start: Node): Node[] {
  const found: Node[] = [];
  const cursor = start.walk(); // bounded to `start`: gotoParent stops there
  try {
    for (;;) {
      if (cursor.nodeIsNamed) found.push(cursor.currentNode);
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) if (!cursor.gotoParent()) return found;
    }
  } finally {
    cursor.delete();
  }
}

// `node` itself first, then everything under it.
export function subtree(node: Node): Node[] {
  if (node.parent) return namedNodes(node);
  let all = wholeTrees.get(node.tree);
  if (!all) wholeTrees.set(node.tree, (all = namedNodes(node)));
  return all;
}

export function* descendants(node: Node): Generator<Node> {
  const all = subtree(node);
  for (let i = 1; i < all.length; i++) yield all[i]!;
}

export function enclosingClass(node: Node, classType: string): string | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === classType) return p.childForFieldName("name")?.text;
  }
  return undefined;
}

// The text inside a string literal node: 'x', "x" and `x` all give x.
export const unquote = (node: Node) => node.text.replace(/^['"`]|['"`]$/g, "");

// Deepest nesting of if/for/while/try inside a body. Stops at inner functions, and an
// `else if` chain counts as one level, not one more per branch.
function nestingDepth(node: Node, syntax: Syntax): number {
  let deepest = 0;
  for (const child of node.namedChildren) {
    if (syntax.functionTypes.includes(child.type)) continue;
    const elseIf = child.type === "if_statement" && node.type === "else_clause";
    const adds = syntax.nesting.includes(child.type) && !elseIf ? 1 : 0;
    deepest = Math.max(deepest, adds + nestingDepth(child, syntax));
  }
  return deepest;
}

function namesIn(node: Node): Set<string> {
  const names = new Set<string>();
  for (const n of descendants(node)) if (n.type === "identifier" || n.type === "shorthand_property_identifier") names.add(n.text);
  return names;
}

// Names used as values in a file: passed as a callback, registered as a handler, rendered as
// <Component />. Calls (name()) and definitions don't count.
export function valueReferences(root: Node, syntax: Syntax): Set<string> {
  const refs = new Set<string>();
  for (const node of descendants(root)) {
    if (node.type !== "identifier") continue;
    const parent = node.parent;
    if (!parent) continue;
    const field = (name: string) => parent.childForFieldName(name)?.startIndex === node.startIndex;
    if (parent.type === syntax.callType && field("function")) continue;
    if ((syntax.functionTypes.includes(parent.type) || parent.type === "variable_declarator") && field("name")) continue;
    refs.add(node.text);
  }
  return refs;
}

// The parts of a FunctionInfo that every language fills in the same way.
export function commonInfo(
  node: Node,
  { name, file, language, syntax, params, valueRefs }: {
    name: string; file: string; language: LanguageId; syntax: Syntax; params: string[]; valueRefs: Set<string>;
  },
) {
  const body = node.childForFieldName("body") ?? node;
  const used = namesIn(body);
  return {
    name,
    file,
    language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params,
    async: node.children.some((c) => c.type === "async"),
    nesting: nestingDepth(body, syntax),
    unusedParams: params.filter((p) => /^\w+$/.test(p) && !used.has(p)),
    passedAsValue: valueRefs.has(name),
    shape: shapeOf(body, node),
  } satisfies Partial<FunctionInfo>;
}
