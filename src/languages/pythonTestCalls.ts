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

export function extractPythonTestCalls(root: Node): ApiCall[] {
  const clients = clientNames(root);
  const found: ApiCall[] = [];
  for (const node of descendants(root)) {
    const fn = node.type === "call" ? node.childForFieldName("function") : null;
    if (fn?.type !== "attribute") continue;
    const verb = fn.childForFieldName("attribute")?.text ?? "";
    const on = fn.childForFieldName("object")?.text ?? "";
    if (!METHODS.has(verb) || !(clients.has(on) || CLIENT_NAME.test(on))) continue;
    // reverse("note-detail") isn't a path we can read; those calls are skipped for now.
    const url = stringValue(node.childForFieldName("arguments")?.namedChildren[0]);
    if (url !== undefined) found.push({ method: verb.toUpperCase(), url, line: node.startPosition.row + 1 });
  }
  return found;
}
