import type { Node } from "web-tree-sitter";
import type { ApiCall } from "../rules/crossStack/types.ts";
import { methodOption } from "./jsCalls.ts";
import { args, METHOD_NAMES, objectProp } from "./jsRoutes.ts";
import { stringValues } from "./jsValues.ts";
import { descendants } from "./nodes.ts";

// Calls a JS/TS test file makes to the app in-process, without a running server:
// supertest (Express, Koa, NestJS), Fastify's inject and Hono's app.request. Next.js route
// tests import the handler instead; src/testing/coverage.ts reads those from the imports.

// supertest under its usual names, given an Express app, Koa's callback or Nest's HTTP server.
const SUPERTEST = /^(request|supertest)(\.agent)?$/;

const calleeOf = (call: Node) => call.childForFieldName("function");

// A value that sends requests: supertest(app), or Fastify's chained app.inject().
function isRequester(node: Node | null | undefined, clients: Set<string>): boolean {
  if (node?.type === "identifier") return clients.has(node.text);
  if (node?.type !== "call_expression") return false;
  const fn = calleeOf(node);
  return SUPERTEST.test(fn?.text ?? "") || (fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "inject" && !args(node).length);
}

// `const api = request(app)`, `agent = request.agent(app)` in a beforeEach.
function requesterNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const node of descendants(root)) {
    const [name, value] = node.type === "variable_declarator" ? [node.childForFieldName("name"), node.childForFieldName("value")]
      : node.type === "assignment_expression" ? [node.childForFieldName("left"), node.childForFieldName("right")] : [];
    if (name?.type === "identifier" && isRequester(value, names)) names.add(name.text);
  }
  return names;
}

function push(found: ApiCall[], urlNode: Node | undefined, method: string | undefined, line: number): void {
  if (!urlNode) return;
  for (const value of stringValues(urlNode) ?? []) found.push({ method, url: value, line });
}

export function extractJsTestCalls(root: Node): ApiCall[] {
  const clients = requesterNames(root);
  const found: ApiCall[] = [];
  for (const node of descendants(root)) {
    const fn = node.type === "call_expression" ? calleeOf(node) : null;
    if (fn?.type !== "member_expression") continue;
    const object = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property")?.text ?? "";
    const [first, second] = args(node);
    const line = node.startPosition.row + 1;
    const verb = prop === "del" ? "delete" : prop;
    if (METHOD_NAMES.has(verb) && isRequester(object, clients)) push(found, first, verb === "all" ? undefined : verb.toUpperCase(), line);
    // Fastify: app.inject({ method: "POST", url: "/notes" }); no method means GET.
    else if (prop === "inject" && first?.type === "object") push(found, objectProp(first, "url"), methodOption(first), line);
    // Hono: app.request("/notes", { method: "DELETE" }).
    else if (prop === "request" && (first?.type === "string" || first?.type === "template_string")) push(found, first, methodOption(second), line);
  }
  return found;
}
