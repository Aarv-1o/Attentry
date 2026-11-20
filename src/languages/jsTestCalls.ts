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

// The variable holding the app: `app` in app, app.callback() and app.getHttpServer().
function appName(node: Node | null | undefined): string | undefined {
  if (node?.type === "identifier") return node.text;
  const object = node?.type === "call_expression" ? calleeOf(node)?.childForFieldName("object") : undefined;
  return object?.type === "identifier" ? object.text : undefined;
}

// A value that sends requests: supertest(app), or Fastify's chained app.inject(). Returns
// { app } with the app it sends to (when it's a plain variable), or undefined if it isn't one.
type Requester = { app: string | undefined } | undefined;
type Requesters = Map<string, Requester>;
function requester(node: Node | null | undefined, clients: Requesters): Requester {
  if (node?.type === "identifier") return clients.get(node.text);
  if (node?.type !== "call_expression") return undefined;
  const fn = calleeOf(node);
  if (SUPERTEST.test(fn?.text ?? "")) return { app: appName(args(node)[0]) };
  const injected = fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "inject" && !args(node).length;
  return injected ? { app: appName(fn.childForFieldName("object")) } : undefined;
}

// `const api = request(app)`, `agent = request.agent(app)` in a beforeEach.
function requesterNames(root: Node): Requesters {
  const names: Requesters = new Map();
  for (const node of descendants(root)) {
    const [name, value] = node.type === "variable_declarator" ? [node.childForFieldName("name"), node.childForFieldName("value")]
      : node.type === "assignment_expression" ? [node.childForFieldName("left"), node.childForFieldName("right")] : [];
    const found = name?.type === "identifier" ? requester(value, names) : undefined;
    if (found) names.set(name!.text, found);
  }
  return names;
}

function push(found: ApiCall[], urlNode: Node | undefined, method: string | undefined, line: number, app: string | undefined): void {
  if (!urlNode) return;
  for (const value of stringValues(urlNode) ?? []) found.push({ method, url: value, line, ...(app ? { app } : {}) });
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
    const sent = METHOD_NAMES.has(verb) ? requester(object, clients) : undefined;
    if (sent) push(found, first, verb === "all" ? undefined : verb.toUpperCase(), line, sent.app);
    // Fastify: app.inject({ method: "POST", url: "/notes" }); no method means GET. Projects wrap it
    // (app.injectWithLogin(email, { url })): any inject… given { url } sends a request.
    else if (/^inject/.test(prop)) {
      const options = args(node).find((a) => a.type === "object" && objectProp(a, "url"));
      if (options) push(found, objectProp(options, "url"), methodOption(options), line, appName(object));
    }
    // Hono: app.request("/notes", { method: "DELETE" }).
    else if (prop === "request" && (first?.type === "string" || first?.type === "template_string")) push(found, first, methodOption(second), line, appName(object));
  }
  return found;
}
