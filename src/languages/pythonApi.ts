import type { Node } from "web-tree-sitter";
import { HOLE } from "../rules/crossStack/paths.ts";
import { emptyApi, type FileApi } from "../rules/crossStack/types.ts";
import { descendants } from "./nodes.ts";
import { djangoRoutes } from "./pythonDjango.ts";

// FastAPI and Flask routes, routers and how they're mounted, in one Python file.

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
// When a router isn't created in the file, go by its name.
const ROUTER_NAME = /^(app|api|router|bp|blueprint|\w+_(router|bp|blueprint|app))$/;

// A string literal's value; f-string parts become HOLE. undefined for anything else.
export function stringValue(node: Node | null | undefined): string | undefined {
  if (node?.type !== "string") return undefined;
  return node.namedChildren
    .map((part) => (part.type === "string_content" ? part.text : part.type === "interpolation" ? HOLE : ""))
    .join("");
}

// No prefix: "". A prefix from a setting (settings.API_V1_STR): HOLE, so only the rest is known.
const prefixValue = (node: Node | undefined) => (node ? (stringValue(node) ?? HOLE) : "");

const argsOf = (call: Node) => call.childForFieldName("arguments")?.namedChildren ?? [];

function keyword(call: Node, name: string): Node | undefined {
  const arg = argsOf(call).find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === name);
  return arg?.childForFieldName("value") ?? undefined;
}

const MAX_BODY = 4000;

// FastAPI dependencies=[Depends(get_current_user)] on an app, router or route.
const dependencies = (call: Node) => keyword(call, "dependencies")?.namedChildren.map((d) => d.text.slice(0, 80)) ?? [];

// What guards a view: its other decorators (@login_required, @jwt_required()) and parameters
// that pull in the user (current_user: CurrentUser, user = Depends(get_current_user)).
export function viewGuards(definition: Node, decorators: Node[]): string[] {
  const params = definition.childForFieldName("parameters")?.namedChildren ?? [];
  return [
    ...decorators.map((d) => d.text.replace(/^@/, "").slice(0, 80)),
    ...params.filter((p) => p.type !== "identifier").map((p) => p.text.slice(0, 80)),
  ];
}

// app = FastAPI(), router = APIRouter(prefix="/api"), bp = Blueprint("x", __name__, url_prefix="/x")
function findRouters(root: Node, api: FileApi): void {
  for (const node of descendants(root)) {
    if (node.type !== "assignment") continue;
    const name = node.childForFieldName("left");
    const value = node.childForFieldName("right");
    if (name?.type !== "identifier" || value?.type !== "call") continue;
    const callee = value.childForFieldName("function")?.text.split(".").at(-1);
    const guards = dependencies(value);
    if (callee === "FastAPI" || callee === "Flask") api.routers.set(name.text, { prefix: "", isApp: true, guards });
    else if (callee === "APIRouter" || callee === "Blueprint") {
      const prefix = prefixValue(keyword(value, callee === "APIRouter" ? "prefix" : "url_prefix"));
      api.routers.set(name.text, { prefix, isApp: false, guards });
    }
  }
}

function routesOf(decorated: Node, api: FileApi): void {
  const definition = decorated.childForFieldName("definition");
  const handler = definition?.childForFieldName("name")?.text;
  const decorators = decorated.namedChildren.filter((d) => d.type === "decorator");
  const isRoute = (d: Node) => /^@\w+\.(get|post|put|patch|delete|route|api_route)\(/.test(d.text);
  const body = definition?.text.slice(0, MAX_BODY);
  const base = definition ? viewGuards(definition, decorators.filter((d) => !isRoute(d))) : [];
  for (const decorator of decorators) {
    const call = decorator.namedChildren[0];
    const fn = call?.type === "call" ? call.childForFieldName("function") : undefined;
    const router = fn?.type === "attribute" ? fn.childForFieldName("object")?.text : undefined;
    const kind = fn?.childForFieldName("attribute")?.text ?? "";
    if (!call || !router || (!api.routers.has(router) && !ROUTER_NAME.test(router))) continue;
    const path = stringValue(argsOf(call)[0]);
    if (path === undefined) continue;
    const line = decorator.startPosition.row + 1;
    let methods: string[] = [];
    if (ROUTE_METHODS.has(kind)) methods = [kind.toUpperCase()];
    else if (kind === "route" || kind === "api_route") {
      // Flask's default is GET only.
      const list = keyword(call, "methods");
      methods = list ? list.namedChildren.map((m) => stringValue(m)?.toUpperCase() ?? "ALL") : [kind === "route" ? "GET" : "ALL"];
    }
    const guards = [...base, ...dependencies(call)];
    for (const method of methods) api.routes.push({ method, path, router, line, guards, ...(handler ? { handler } : {}), ...(body ? { body } : {}) });
  }
}

// Mounting a router: include_router (FastAPI, with prefix=) or register_blueprint (Flask, url_prefix=).
function mountOf(call: Node, api: FileApi): void {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "attribute") return;
  const kind = fn.childForFieldName("attribute")?.text;
  const on = fn.childForFieldName("object")?.text;
  if (!on || (kind !== "include_router" && kind !== "register_blueprint")) return;
  const target = argsOf(call)[0];
  if (target?.type !== "identifier" && target?.type !== "attribute") return;
  const prefix = prefixValue(keyword(call, kind === "include_router" ? "prefix" : "url_prefix"));
  api.mounts.push({ prefix, on, target: target.text, line: call.startPosition.row + 1, guards: dependencies(call) });
}

export function extractPythonApi(root: Node): FileApi {
  const api = emptyApi();
  findRouters(root, api);
  for (const node of descendants(root)) {
    if (node.type === "decorated_definition") routesOf(node, api);
    else if (node.type === "call") mountOf(node, api);
  }
  djangoRoutes(root, api);
  return api;
}
