import type { Node } from "web-tree-sitter";
import type { ApiCall } from "../rules/crossStack/types.ts";
import { descendants } from "./nodes.ts";
import { stringValue } from "./pythonApi.ts";

// Calls a Python test file makes to the app in-process: FastAPI's TestClient, Flask's
// app.test_client(), Django's self.client / Client() and DRF's APIClient, httpx's AsyncClient.

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
// pytest fixtures and Django's TestCase hand the client over by name.
const CLIENT_NAME = /^(self\.)?\w*client$/i;
const CLIENT_FACTORY = /(^|\.)(TestClient|AsyncClient|Client|APIClient|test_client)$/;
const REVERSE = /^(reverse|reverse_lazy)$/;

const makesClient = (value: Node | null | undefined) =>
  value?.type === "call" && CLIENT_FACTORY.test(value.childForFieldName("function")?.text ?? "");

// Clients under other names: `c = app.test_client()`, `async with AsyncClient(...) as ac:`.
function clientNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const node of descendants(root)) {
    if (node.type === "assignment" && makesClient(node.childForFieldName("right"))) names.add(node.childForFieldName("left")!.text);
    if (node.type === "as_pattern" && makesClient(node.namedChildren[0])) {
      const alias = node.childForFieldName("alias")?.text;
      if (alias) names.add(alias);
    }
  }
  return names;
}

// The route name in reverse("notes:note-detail", args=[1]), also inside reverse(...) + "?page=2".
function reversedName(node: Node | null | undefined): string | undefined {
  for (const n of node ? [node, ...descendants(node)] : []) {
    if (n.type === "call" && REVERSE.test(n.childForFieldName("function")?.text ?? "")) {
      return stringValue(n.childForFieldName("arguments")?.namedChildren[0]);
    }
  }
  return undefined;
}

// `url = reverse(...)`, `self.url = reverse(...)` in setUp: the variable a request is sent to.
interface Reversed { target: string; name: string; line: number; scope: Node | null }
const functionOf = (node: Node): Node | null => {
  for (let n = node.parent; n; n = n.parent) if (n.type === "function_definition") return n;
  return null;
};

function reversedVariables(root: Node): Reversed[] {
  return [...descendants(root)].flatMap((node) => {
    const name = node.type === "assignment" ? reversedName(node.childForFieldName("right")) : undefined;
    return name ? [{ target: node.childForFieldName("left")!.text, name, line: node.startPosition.row + 1, scope: functionOf(node) }] : [];
  });
}

// The nearest assignment before the request in the same function; else, if every assignment
// to that variable (in setUp, at the top) names the same route, that one.
function nameOfVariable(arg: Node, assigned: Reversed[]): string | undefined {
  const same = assigned.filter((a) => a.target === arg.text);
  const scope = functionOf(arg);
  const local = same.filter((a) => a.scope?.id === scope?.id && a.line <= arg.startPosition.row + 1).at(-1);
  if (local) return local.name;
  const names = new Set(same.map((a) => a.name));
  return names.size === 1 ? [...names][0] : undefined;
}

export function extractPythonTestCalls(root: Node): ApiCall[] {
  const clients = clientNames(root);
  const assigned = reversedVariables(root);
  const found: ApiCall[] = [];
  for (const node of descendants(root)) {
    const fn = node.type === "call" ? node.childForFieldName("function") : null;
    if (fn?.type !== "attribute") continue;
    const verb = fn.childForFieldName("attribute")?.text ?? "";
    const on = fn.childForFieldName("object")?.text ?? "";
    if (!METHODS.has(verb) || !(clients.has(on) || CLIENT_NAME.test(on))) continue;
    const arg = node.childForFieldName("arguments")?.namedChildren[0];
    const call = { method: verb.toUpperCase(), line: node.startPosition.row + 1 };
    const url = stringValue(arg);
    const routeName = url === undefined && arg
      ? (reversedName(arg) ?? (arg.type === "identifier" || arg.type === "attribute" ? nameOfVariable(arg, assigned) : undefined))
      : undefined;
    if (url !== undefined) found.push({ ...call, url });
    else if (routeName) found.push({ ...call, url: "", routeName });
  }
  return found;
}
