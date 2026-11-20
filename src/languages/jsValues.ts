import type { Node } from "web-tree-sitter";
import { HOLE } from "../rules/crossStack/paths.ts";
import { unquote } from "./nodes.ts";

// The string values a JS expression can have, as far as the file itself says:
// `${API}/usage` with `const API = "/api/agent"` is "/api/agent/usage". Parts that
// can't be worked out (a parameter, process.env.X) become HOLE.

const MAX_DEPTH = 5;
const MAX_VALUES = 4; // a ternary of ternaries: stop before the combinations pile up
// A value holding a whole path, not one segment of it: `${BASE}${path}` could be anything.
const WHOLE_PATH = /^(path|url|endpoint|route|uri|href)$|(Path|Url|URL|Endpoint|Route)$/;

// `let`/`var` may be set again later (`newPostId = body.id` after a create): then the first value
// says nothing about what the variable holds where it's used.
const reassigned = (name: string, scope: Node) =>
  scope.descendantsOfType(["assignment_expression", "augmented_assignment_expression"]).some((a) => a?.childForFieldName("left")?.text === name);

// `const NAME = value` visible from `at`: the nearest enclosing block that declares it, before `at`.
// A `let` or `var` counts only if nothing in that block sets it again.
function declaration(name: string, at: Node): Node | undefined {
  for (let scope = at.parent; scope; scope = scope.parent) {
    if (scope.type !== "statement_block" && scope.type !== "program") continue;
    let found: Node | undefined;
    let mutable = false;
    for (const statement of scope.namedChildren) {
      const decl = statement.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
      if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") continue;
      // In a function body, only what's declared before the use counts; at the top level, any.
      if (scope.type !== "program" && statement.startIndex > at.startIndex) break;
      for (const d of decl.namedChildren) {
        if (d.type === "variable_declarator" && d.childForFieldName("name")?.text === name) {
          found = d.childForFieldName("value") ?? undefined;
          mutable = decl.firstChild?.type !== "const";
        }
      }
    }
    if (found) return mutable && reassigned(name, scope) ? undefined : found;
  }
  return undefined;
}

const cross = (a: string[], b: string[]) => a.flatMap((x) => b.map((y) => x + y)).slice(0, MAX_VALUES);

// Returns undefined when the value can't be used at all (it's a whole unknown path).
export function stringValues(node: Node, depth = 0): string[] | undefined {
  if (depth > MAX_DEPTH) return [HOLE];
  const next = (n: Node | null) => (n ? stringValues(n, depth + 1) : [HOLE]);
  switch (node.type) {
    case "string":
      return [unquote(node)];
    case "template_string": {
      let values: string[] | undefined = [""];
      for (const part of node.namedChildren) {
        if (part.type === "string_fragment" || part.type === "escape_sequence") values = cross(values, [part.text]);
        else if (part.type === "template_substitution") {
          const inner = part.namedChildren[0];
          const sub = inner ? stringValues(inner, depth + 1) : [HOLE];
          if (!sub) return undefined;
          values = cross(values, sub);
        }
      }
      return values;
    }
    case "binary_expression": {
      const op = node.childForFieldName("operator")?.text;
      const left = next(node.childForFieldName("left"));
      const right = next(node.childForFieldName("right"));
      if (!left || !right) return undefined;
      if (op === "+") return cross(left, right);
      if (op === "||" || op === "??") return [...left, ...right].slice(0, MAX_VALUES); // env value or a fallback
      return [HOLE];
    }
    case "ternary_expression": {
      const a = next(node.childForFieldName("consequence"));
      const b = next(node.childForFieldName("alternative"));
      return a && b ? [...a, ...b].slice(0, MAX_VALUES) : undefined;
    }
    case "parenthesized_expression":
      return next(node.namedChildren[0] ?? null);
    case "identifier": {
      const value = declaration(node.text, node);
      if (value) return stringValues(value, depth + 1);
      return WHOLE_PATH.test(node.text) ? undefined : [HOLE];
    }
    default:
      return [HOLE];
  }
}
