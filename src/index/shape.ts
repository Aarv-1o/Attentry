import type { Node } from "web-tree-sitter";

const NAME_TYPES = new Set(["identifier", "type_identifier", "statement_identifier"]);

// Property names say what the code does to an object: `connect` vs `disconnect`, `push` vs `pop`,
// `prisma.user` vs `prisma.post`. Renaming them would make opposite functions look identical.
const PROPERTY_TYPES = new Set(["property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"]);

// Where a name is declared: a parameter, a local variable, a loop variable. Only these are
// the function's own to rename; any other name (an import, a global) is code it calls.
const DECLARING_FIELDS: [RegExp, string][] = [
  [/^(variable_declarator|function_declaration|function_definition|class_declaration|class_definition|generator_function_declaration|default_parameter|typed_default_parameter)$/, "name"],
  [/^(assignment|assignment_expression|augmented_assignment|augmented_assignment_expression|for_in_statement|for_statement|for_in_clause)$/, "left"],
  [/^(catch_clause|arrow_function)$/, "parameter"],
  [/^as_pattern$/, "alias"],
];
const DECLARING_PARENTS = /parameter|pattern/;

const LITERAL_TYPES = new Set(["number", "regex", "integer", "float"]);

// The text parts of strings. Strings themselves are walked into, because
// template strings and f-strings contain variable names.
const STRING_TEXT_TYPES = new Set(["string_fragment", "string_content", "escape_sequence"]);

// 'a', "a" and `a` should look the same.
const QUOTE_TYPES = new Set(["'", '"', "`", "string_start", "string_end"]);

export const LITERAL_PREFIX = "lit:";
export const JSX_MARKER = "jsx";
const LOCAL_PREFIX = "$";
const OUTER_PREFIX = "~"; // a name from outside the function, kept as written
const PROPERTY_PREFIX = "."; // a property or attribute name, kept as written

// Any kind of name, for comparing structure with every name blanked out.
export const isName = (token: string) => token.startsWith(LOCAL_PREFIX) || token.startsWith(OUTER_PREFIX) || token.startsWith(PROPERTY_PREFIX);

const isProperty = (node: Node) =>
  PROPERTY_TYPES.has(node.type) ||
  // Python: obj.attr, and keyword arguments f(connect=...)
  (node.parent?.type === "attribute" && node.parent.childForFieldName("attribute")?.id === node.id) ||
  (node.parent?.type === "keyword_argument" && node.parent.childForFieldName("name")?.id === node.id);

function declares(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (DECLARING_FIELDS.some(([types, field]) => types.test(parent.type) && parent.childForFieldName(field)?.id === node.id)) return true;
  for (let p: Node | null = parent; p; p = p.parent) {
    if (DECLARING_PARENTS.test(p.type)) return true;
    if (!/list|tuple|splat|assignment_pattern|pair_pattern/.test(p.type)) return false;
  }
  return false;
}

// The names `scope` declares: its parameters and every local in it.
function localNames(scope: Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    if (NAME_TYPES.has(node.type) && !isProperty(node) && declares(node)) names.add(node.text);
    if (node.type === "shorthand_property_identifier_pattern") names.add(node.text); // const { id } = x
    for (const child of node.children) visit(child);
  };
  visit(scope);
  return names;
}

// The body as a token list where local names don't matter but structure, literals, property
// names and the outside code it calls do. Two functions that differ only in what their own
// variables are called get the same shape; `followUser` and `unfollowUser` (connect vs
// disconnect) don't.
export function shapeOf(body: Node, scope: Node = body): string[] {
  const locals = localNames(scope);
  const names = new Map<string, string>();
  const tokens: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === "comment") return;
    // A string on its own does nothing: a docstring, or "use strict".
    if (node.type === "expression_statement" && node.namedChildCount === 1 && node.namedChild(0)?.type === "string") return;
    // One marker per JSX element, so markup-heavy functions (icons, static pages) can be told apart.
    if (node.type === "jsx_element" || node.type === "jsx_self_closing_element") tokens.push(JSX_MARKER);
    if (LITERAL_TYPES.has(node.type) || STRING_TEXT_TYPES.has(node.type)) {
      tokens.push(LITERAL_PREFIX + node.text);
      return;
    }
    if (node.childCount === 0) {
      if (QUOTE_TYPES.has(node.type)) {
        tokens.push("q");
      } else if (isProperty(node)) {
        tokens.push(PROPERTY_PREFIX + node.text);
      } else if (NAME_TYPES.has(node.type) && locals.has(node.text)) {
        if (!names.has(node.text)) names.set(node.text, `${LOCAL_PREFIX}${names.size}`);
        tokens.push(names.get(node.text)!);
      } else if (NAME_TYPES.has(node.type)) {
        tokens.push(OUTER_PREFIX + node.text);
      } else {
        tokens.push(node.type);
      }
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(body);
  return tokens;
}
