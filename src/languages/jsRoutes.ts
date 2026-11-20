import type { Node } from "web-tree-sitter";
import { HOLE } from "../rules/crossStack/paths.ts";
import { HTTP_METHODS, type FileApi } from "../rules/crossStack/types.ts";
import { declaration, stringValues } from "./jsValues.ts";
import { descendants, unquote } from "./nodes.ts";

// Routes and mounts for the frameworks that declare routes as method calls:
// Express, Koa (koa-router), Hono and Fastify. They differ in how routers are made and mounted.

export const METHOD_NAMES = new Set([...HTTP_METHODS.map((m) => m.toLowerCase()), "all"]);
// When a router isn't created in the file (it's a parameter, like a Fastify plugin's), go by its name.
export const ROUTER_NAME = /^(app|server|router|fastify|instance|\w+Router)$/;

export const args = (call: Node) => call.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];

export function objectProp(object: Node | undefined, key: string): Node | undefined {
  if (object?.type !== "object") return undefined;
  const pair = object.namedChildren.find((p) => p.type === "pair" && p.childForFieldName("key")?.text.replace(/['"]/g, "") === key);
  return pair?.childForFieldName("value") ?? undefined;
}

const FUNCTION_NODES = new Set(["arrow_function", "function_expression", "function"]);
const MAX_BODY = 4000;

// How a middleware or handler is named in a report: `protect`, `passport.authenticate("jwt")`.
const nameOfArg = (n: Node) => (n.type === "call_expression" ? n.text : n.text).replace(/\s+/g, " ").slice(0, 80);

// What follows a route's path: middleware, then the handler (inline code or a named function).
function handlerParts(rest: Node[]): { guards: string[]; handler?: string; body?: string } {
  const last = rest.at(-1);
  if (!last) return { guards: [] };
  // Inline middleware counts by its code: (req, reply) => req.isAdmin(reply).
  const guards = rest.slice(0, -1).map(nameOfArg);
  if (FUNCTION_NODES.has(last.type)) return { guards, body: last.text.slice(0, MAX_BODY) };
  return { guards, handler: nameOfArg(last) };
}

const stringProp = (object: Node | undefined, key: string) => {
  const value = objectProp(object, key);
  return value?.type === "string" ? unquote(value) : undefined;
};

// What creates a router or app: express(), Router(), new Router({ prefix }), new Hono().basePath("/api"), Fastify().
function routerOf(value: Node): { prefix: string; isApp: boolean } | undefined {
  let node = value;
  let prefix = "";
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "basePath") {
      const arg = args(node)[0];
      prefix = arg?.type === "string" ? unquote(arg) : "";
      node = fn.childForFieldName("object")!;
    }
  }
  const callee = (node.type === "new_expression" ? node.childForFieldName("constructor") : node.childForFieldName("function"))?.text;
  if (node.type !== "call_expression" && node.type !== "new_expression") return undefined;
  if (callee === "express" || /^[Ff]astify$/.test(callee ?? "") || callee === "Koa") return { prefix, isApp: true };
  // A Hono instance is an app until something mounts it.
  if (callee === "Hono") return { prefix, isApp: true };
  if (/^(express\.)?Router$/.test(callee ?? "")) {
    return { prefix: stringProp(args(node)[0], "prefix") ?? "", isApp: false };
  }
  return undefined;
}

export function findRouters(root: Node, api: FileApi): void {
  for (const node of descendants(root)) {
    if (node.type !== "variable_declarator") continue;
    const value = node.childForFieldName("value");
    const name = node.childForFieldName("name")?.text;
    const router = value && name ? routerOf(value) : undefined;
    if (router) api.routers.set(name!, router);
  }
}

// What a mount points at: `authRouter`, `createAuthRouter(User)`, `require("./auth")`,
// `import("./auth")` (Fastify) or `users.routes()` (Koa).
function mountTarget(node: Node): string | undefined {
  if (node.type === "identifier") return node.text;
  if (node.type === "await_expression") return node.namedChildren[0] ? mountTarget(node.namedChildren[0]) : undefined;
  if (node.type !== "call_expression") return undefined;
  const fn = node.childForFieldName("function");
  const arg = args(node)[0];
  if ((fn?.text === "require" || fn?.type === "import") && arg?.type === "string") return `require:${unquote(arg)}`;
  if (fn?.type === "member_expression" && /^(routes|middleware)$/.test(fn.childForFieldName("property")?.text ?? "")) {
    const object = fn.childForFieldName("object");
    return object?.type === "identifier" ? object.text : undefined;
  }
  return fn?.type === "identifier" ? fn.text : undefined;
}

// The array a loop variable walks: `routes.forEach((route) => ...)` or `for (const route of routes)`.
function loopedArray(variable: string, at: Node): Node | undefined {
  for (let n = at.parent; n; n = n.parent) {
    if (n.type === "for_in_statement" && n.childForFieldName("left")?.text.replace(/^(const|let|var)\s+/, "") === variable) {
      const right = n.childForFieldName("right");
      return right?.type === "identifier" ? declaration(right.text, n) : undefined;
    }
    if (n.type !== "arrow_function" && n.type !== "function_expression") continue;
    const params = n.childForFieldName("parameters")?.namedChildren ?? (n.childForFieldName("parameter") ? [n.childForFieldName("parameter")!] : []);
    if (params[0]?.text !== variable) continue;
    const call = n.parent?.parent;
    const fn = call?.type === "call_expression" ? call.childForFieldName("function") : undefined;
    const list = fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "forEach" ? fn.childForFieldName("object") : undefined;
    return list?.type === "identifier" ? declaration(list.text, n) : undefined;
  }
  return undefined;
}

// `router.use(route.path, route.route)` in a loop over [{ path: "/users", route: userRoute }]:
// one mount per entry. Popular Express boilerplates list their routers this way.
function loopMounts(prefixNode: Node, targetNode: Node): { prefix: string; target: string }[] {
  if (prefixNode.type !== "member_expression" || targetNode.type !== "member_expression") return [];
  const variable = prefixNode.childForFieldName("object")?.text;
  if (!variable || targetNode.childForFieldName("object")?.text !== variable) return [];
  const list = loopedArray(variable, prefixNode);
  if (list?.type !== "array") return [];
  const [pathKey, routeKey] = [prefixNode, targetNode].map((n) => n.childForFieldName("property")?.text ?? "");
  return list.namedChildren.flatMap((entry) => {
    const prefix = stringProp(entry, pathKey!);
    const target = objectProp(entry, routeKey!);
    const name = target ? mountTarget(target) : undefined;
    return prefix !== undefined && name ? [{ prefix, target: name }] : [];
  });
}

// Mounting a router: use() (Express, Koa), route() with a path and a sub-app (Hono), or
// register() with a prefix option (Fastify).
export function mountOf(on: string, prop: string, call: Node, api: FileApi): boolean {
  const all = args(call);
  const line = call.startPosition.row + 1;
  if (prop === "use") {
    const looped = all.length === 2 ? loopMounts(all[0]!, all[1]!) : [];
    for (const { prefix, target } of looped) api.mounts.push({ prefix, on, target, line, guards: [] });
    if (looped.length) return true;
    const target = all.length ? mountTarget(all.at(-1)!) : undefined;
    const hasPrefix = all[0]?.type === "string" && all.length > 1;
    const prefix = hasPrefix ? unquote(all[0]!) : "";
    const guards = all.slice(hasPrefix ? 1 : 0, -1).filter((n) => !FUNCTION_NODES.has(n.type)).map(nameOfArg);
    if (target) api.mounts.push({ prefix, on, target, line, guards });
    return true;
  }
  // Fastify hooks: fastify.addHook("onRequest", checkAuth) guards every route on that instance;
  // in an autohooks file (@fastify/autoload), every route in the folder.
  if (prop === "addHook" && /^["'](onRequest|preHandler|preValidation|preParsing)["']$/.test(all[0]?.text ?? "") && all[1]) {
    const hook = all[1];
    const label = FUNCTION_NODES.has(hook.type) ? (/unauthori[sz]ed|authenticat|session|jwt|verify|login/i.test(hook.text) ? "onRequest hook (checks auth)" : "onRequest hook") : nameOfArg(hook);
    if (api.autohooks) api.folderGuards.push(label);
    else api.mounts.push({ prefix: "", on, target: "", line: 0, guards: [label] });
    return true;
  }
  if (prop === "route" && all.length === 2 && all[0]?.type === "string") {
    const target = mountTarget(all[1]!);
    if (target) api.mounts.push({ prefix: unquote(all[0]), on, target, line, guards: [] });
    return true;
  }
  if (prop === "register" && all[0]) {
    const target = mountTarget(all[0]);
    // A prefix from a variable: HOLE, so only the rest of the path is known.
    const prefix = objectProp(all[1], "prefix") ? (stringProp(all[1], "prefix") ?? HOLE) : "";
    if (target) api.mounts.push({ prefix, on, target, line, guards: [] });
    return true;
  }
  return false;
}

// The router at the start of a chain: `router.get(...).post(...)` -> router.
function chainRoot(node: Node): Node | undefined {
  if (node.type === "identifier") return node;
  const fn = node.type === "call_expression" ? node.childForFieldName("function") : undefined;
  const object = fn?.type === "member_expression" ? fn.childForFieldName("object") : undefined;
  return object ? chainRoot(object) : undefined;
}

// The path for `.get(h)` in `router.route("/x").get(h).post(h)` (Express).
function routePathOf(chain: Node): Node | undefined {
  const fn = chain.type === "call_expression" ? chain.childForFieldName("function") : undefined;
  if (fn?.type !== "member_expression") return undefined;
  if (fn.childForFieldName("property")?.text === "route") return args(chain)[0];
  return routePathOf(fn.childForFieldName("object")!);
}

const isPath = (n: Node | undefined) => n?.type === "string" || n?.type === "template_string";

// `router.get("/x", h)`, Koa chains `router.get("/a", h).post("/b", h)`, Express
// `router.route("/x").get(h)`, Fastify `app.route({ method, url })`.
export function routesOf(object: Node, prop: string, call: Node, api: FileApi): void {
  const root = chainRoot(object);
  if (!root) return;
  const line = call.startPosition.row + 1;
  const [first, second] = args(call);
  if (prop === "route" && first?.type === "object") {
    const url = objectProp(first, "url");
    const method = objectProp(first, "method");
    const methods = method?.type === "array" ? method.namedChildren.map(unquote) : method?.type === "string" ? [unquote(method)] : ["ALL"];
    const hooks = ["onRequest", "preHandler", "preValidation"].flatMap((k) => {
      const v = objectProp(first, k);
      return v ? (v.type === "array" ? v.namedChildren.map(nameOfArg) : [nameOfArg(v)]) : [];
    });
    const handler = objectProp(first, "handler");
    const parts = handler ? handlerParts([handler]) : { guards: [] };
    for (const path of url ? stringValues(url) ?? [] : []) {
      for (const m of methods) api.routes.push({ method: m.toUpperCase(), path, router: root.text, line, ...parts, guards: hooks });
    }
    return;
  }
  if (!METHOD_NAMES.has(prop)) return;
  // Its own path needs a handler after it; otherwise the path comes from .route("/x").
  const ownPath = isPath(first) && second;
  const path = ownPath ? first : object.type === "identifier" ? undefined : routePathOf(object);
  if (!isPath(path)) return;
  // Fastify puts hooks in an options object: app.get("/x", { preHandler: [auth] }, handler).
  const rest = args(call).slice(ownPath ? 1 : 0).flatMap((n) => {
    if (n.type !== "object") return [n];
    return ["onRequest", "preHandler", "preValidation"].flatMap((k) => {
      const v = objectProp(n, k);
      return v ? (v.type === "array" ? v.namedChildren : [v]) : [];
    });
  });
  const parts = handlerParts(rest);
  for (const value of stringValues(path!) ?? []) api.routes.push({ method: prop.toUpperCase(), path: value, router: root.text, line, ...parts });
}
