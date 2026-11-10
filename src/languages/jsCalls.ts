import type { Node } from "web-tree-sitter";
import { HOLE } from "../rules/crossStack/paths.ts";
import type { FileApi } from "../rules/crossStack/types.ts";
import { args, METHOD_NAMES, objectProp as objectValue, ROUTER_NAME } from "./jsRoutes.ts";
import { stringValues } from "./jsValues.ts";
import { descendants, unquote } from "./nodes.ts";

// The API calls a JS/TS file makes: fetch, axios and its instances, other HTTP clients,
// and your own wrappers around them.

// HTTP clients and instances named like one. `api.get("/users")` is a call, not a route.
const CLIENT_NAME = /^(axios|api|http|client|requests?|agent|superagent|ky|\w+Api|\w+Client|\$)$/;
// Your own wrapper around fetch: apiFetch("/users"). It may add a base URL we can't see.
const WRAPPER_NAME = /^(\w*(fetch|request)\w*|api\w*|\w+Api)$/i;
// Instance factories: axios.create({ baseURL }), apisauce create({ baseURL }) (React Native), ky.create({ prefixUrl }).
const FACTORY = /^(axios\.create|create|ky\.(create|extend)|ofetch\.create)$/;

export function methodOption(options: Node | undefined): string | undefined {
  if (!options) return "GET";
  if (options.type !== "object") return undefined;
  const method = objectValue(options, "method");
  // { method } is { method: method }: a value we can't read, like a spread that may set it.
  const unreadable = (p: Node) => p.type === "spread_element" || (p.type === "shorthand_property_identifier" && p.text === "method");
  if (!method) return options.namedChildren.some(unreadable) ? undefined : "GET";
  return method.type === "string" ? unquote(method).toUpperCase() : undefined;
}

// `const api = axios.create({ baseURL: "http://localhost:8000/api" })`: calls on `api` start there.
export function findClients(root: Node, api: FileApi): void {
  for (const node of descendants(root)) {
    const value = node.type === "variable_declarator" ? node.childForFieldName("value") : node.type === "export_statement" ? node.childForFieldName("value") : null;
    if (value?.type !== "call_expression" || !FACTORY.test(value.childForFieldName("function")?.text ?? "")) continue;
    const options = args(value)[0];
    const base = objectValue(options, "baseURL") ?? objectValue(options, "prefixUrl");
    const values = base ? stringValues(base) : undefined;
    const name = node.type === "export_statement" ? "default" : node.childForFieldName("name")?.text;
    // An unreadable base (process.env.API_URL) is still a base: only the end of the path is known.
    if (name) api.clients.set(name, values?.length === 1 ? values[0]! : HOLE);
  }
  for (const node of root.namedChildren) {
    const value = node.type === "export_statement" ? node.childForFieldName("value") : null;
    if (value?.type === "identifier" && api.clients.has(value.text)) api.clients.set("default", api.clients.get(value.text)!);
  }
}

interface CallInfo {
  method: string | undefined;
  line: number;
  wrapper?: boolean; // your own helper, which may add a base URL we can't see
  via?: { name: string; client: boolean }; // called on an object: maybe a client with a base URL
}

function addCall(api: FileApi, urlNode: Node | undefined, call: CallInfo): void {
  const { method, line, wrapper = false, via } = call;
  if (!urlNode) return;
  for (const value of stringValues(urlNode) ?? []) {
    const url = value.split(/[?#]/)[0]!;
    if (/[^/]\u0000$/.test(url)) continue; // ends in an unknown piece: `/api/items${suffix}`
    if ((wrapper || via) && /^\w+:/.test(url)) {
      api.calls.push({ method, url, line }); // a full URL: the base doesn't apply
      continue;
    }
    if (via) {
      api.calls.push({ method, url, line, via }); // the base URL is found later, maybe in another file
      continue;
    }
    if (wrapper && !url.startsWith("/")) continue;
    api.calls.push({ method, url: wrapper ? HOLE + url : url, line });
  }
}

// axios({ url, method }), generated clients: request(OpenAPI, { method: "GET", url: "/api/v1/items/" }).
function configCall(node: Node, api: FileApi, line: number): boolean {
  const config = args(node).find((a) => a.type === "object" && objectValue(a, "url"));
  if (!config) return false;
  const method = objectValue(config, "method");
  addCall(api, objectValue(config, "url"), { method: method?.type === "string" ? unquote(method).toUpperCase() : undefined, line, wrapper: true });
  return true;
}

export function visitCallSite(node: Node, api: FileApi): void {
  const [first, second] = args(node);
  const line = node.startPosition.row + 1;
  if (node.type === "new_expression") {
    if (node.childForFieldName("constructor")?.text === "EventSource") addCall(api, first, { method: "GET", line });
    return;
  }
  const fn = node.childForFieldName("function");
  // client.post({ url: "/api/v1/items" }): generated API clients pass a config object.
  const verb = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text ?? "" : "";
  if (METHOD_NAMES.has(verb) && first?.type === "object" && objectValue(first, "url")) {
    return addCall(api, objectValue(first, "url"), { method: verb === "all" ? undefined : verb.toUpperCase(), line, wrapper: true });
  }
  if (fn?.type === "identifier") {
    if (fn.text === "fetch") return addCall(api, first, { method: methodOption(second), line });
    if (fn.text === "axios" && first?.type !== "object") return addCall(api, first, { method: methodOption(second), line });
    if (configCall(node, api, line)) return;
    // A wrapper named like fetch passes the options on: authFetch(url, { method: "PUT" }).
    if (WRAPPER_NAME.test(fn.text)) addCall(api, first, { method: /fetch/i.test(fn.text) ? methodOption(second) : undefined, line, wrapper: true });
    return;
  }
  if (fn?.type !== "member_expression") return;
  const object = fn.childForFieldName("object");
  const prop = fn.childForFieldName("property")?.text ?? "";
  if (object?.type !== "identifier") return;
  // The old XMLHttpRequest way: open() takes the method, then the URL.
  if (prop === "open" && first?.type === "string" && METHOD_NAMES.has(unquote(first).toLowerCase())) {
    return addCall(api, second, { method: unquote(first).toUpperCase(), line });
  }
  const name = prop === "del" ? "delete" : prop; // superagent's delete
  if (!METHOD_NAMES.has(name) || api.routers.has(object.text) || ROUTER_NAME.test(object.text)) return;
  const method = name === "all" ? undefined : name.toUpperCase();
  if (object.text === "axios" || object.text === "superagent") return addCall(api, first, { method, line });
  addCall(api, first, { method, line, via: { name: object.text, client: CLIENT_NAME.test(object.text) } });
}

const STRING_TYPES = new Set(["string", "template_string", "binary_expression"]);

// Other URLs in frontend code (src=, href=, url={...}): uses of GET routes, not calls.
export function findMentions(root: Node, api: FileApi): void {
  for (const node of descendants(root)) {
    if (!STRING_TYPES.has(node.type) || STRING_TYPES.has(node.parent?.type ?? "") || node.parent?.type === "template_substitution") continue;
    for (const value of stringValues(node) ?? []) if (value.startsWith("/")) api.mentions.push(value);
  }
}
