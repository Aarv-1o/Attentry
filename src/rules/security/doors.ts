import type { Node } from "web-tree-sitter";
import { appOf } from "../../index/files.ts";
import type { FileUsage } from "../../index/usage.ts";
import { grammarForFile } from "../../languages/index.ts";
import { parseSource } from "../../parse/parse.ts";
import type { FullRoute } from "../crossStack/resolve.ts";
import { walk } from "../line/types.ts";

// Doors to the outside that aren't HTTP routes: Socket.io events, WebSocket messages, tRPC
// procedures, GraphQL resolvers, Next.js server actions. Each becomes a route ("socket event
// \"ride:cancel\"") so the endpoint checks (who's calling, admin role, whose record, rate limit)
// run on them as they do on routes. Any of them can carry an id from the caller.

export type DoorKind = "socket" | "websocket" | "trpc" | "graphql" | "server-action";
export interface Door extends FullRoute {
  kind: DoorKind;
  label: string;
  takesInput: true;
}

const SOCKET_IO = /^socket\.io$/;
const WS = /^(ws|uWebSockets\.js)$/;
const TRPC = /^@trpc\/server(\/|$)/;
const GRAPHQL_SERVER = /^(graphql|@apollo\/server|apollo-server(-[\w-]+)?|graphql-yoga|mercurius|@graphql-tools\/schema)$/;
const GRAPHQL_SHIELD = /^graphql-shield$/;

// Socket.io's own events, not messages from the client.
const LIFECYCLE = new Set(["connection", "connect", "disconnect", "disconnecting", "error", "connect_error", "close", "open", "upgrade", "listening", "headers", "reconnect", "ping", "pong"]);
const READS = /^(get|list|fetch|load|find|search|subscribe|join|watch|ping)\b|[:./](get|list|fetch|load|find|search|subscribe|join|watch)\b/i;
// The connection checks who's there before any event: io.use(...) with a token, or the handshake.
const SOCKET_AUTH = /\.use\(\s*(async\s*)?\(?\s*socket\b[\s\S]{0,600}?(jwt|token|verify|auth|session|getUser|currentUser)|handshake\.(auth|headers)[\s\S]{0,300}?(verify|jwt|session|getUser|currentUser)/i;
const WS_AUTH = /verifyClient|headers\.authorization|headers\[["']authorization|jwt\.verify|verify_?token|getSession\(|getUser\(|cookie[\s\S]{0,100}session/i;

// The GraphQL server's context works out who's calling from the request (a token, a session).
const GRAPHQL_CONTEXT_AUTH = /context\s*[:=]\s*(async\s*)?\(?\s*\{\s*req\b[\s\S]{0,600}?(authorization|jwt|token|session|getUser|verify)/i;
const NEXT_MIDDLEWARE = /(^|\/)(src\/)?(middleware|proxy)\.[jt]s$/;
const NEXT_MIDDLEWARE_AUTH = /NextAuth|\bauth\b|clerkMiddleware|withAuth|getToken|session|supabase|kinde|auth0/i;

const kebab = (word: string) => word.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
function pathFor(name: string) {
  const segments = name.split(/[:./\s]+/).filter(Boolean).map(kebab);
  return { segments, unknownPrefix: false, text: `/${segments.join("/")}` };
}
const unquote = (node: Node | null | undefined) => (node && (node.type === "string" || node.type === "template_string") && !node.text.includes("${") ? node.text.slice(1, -1) : undefined);
const isFunction = (node: Node | null | undefined) => !!node && /^(arrow_function|function_expression|function)$/.test(node.type);
const callName = (call: Node) => call.childForFieldName("function");
const member = (call: Node) => {
  const fn = callName(call);
  return fn?.type === "member_expression" ? { object: fn.childForFieldName("object"), property: fn.childForFieldName("property")?.text } : undefined;
};
const args = (call: Node) => call.childForFieldName("arguments")?.namedChildren ?? [];

function door(kind: DoorKind, label: string, name: string, method: string, file: string, node: Node, body: string, guards: string[]): Door {
  return { kind, label, method, path: pathFor(name), file, line: node.startPosition.row + 1, guards, body, takesInput: true };
}

// socket.on("ride:cancel", handler), in a file of an app that runs a Socket.io server.
function socketDoors(root: Node, file: string, authed: boolean): Door[] {
  const found: Door[] = [];
  for (const node of walk(root)) {
    if (node.type !== "call_expression" || member(node)?.property !== "on") continue;
    const [event, handler] = args(node);
    const name = unquote(event);
    if (!name || LIFECYCLE.has(name) || !isFunction(handler)) continue;
    found.push(door("socket", `socket event "${name}"`, name, READS.test(name) ? "GET" : "POST", file, node, handler!.text, authed ? ["socket-auth"] : []));
  }
  return found;
}

// ws: each connection's "message" handler, with the connection's code (where a token is checked).
function websocketDoors(root: Node, file: string, text: string): Door[] {
  const found: Door[] = [];
  for (const node of walk(root)) {
    if (node.type !== "call_expression" || member(node)?.property !== "on" || unquote(args(node)[0]) !== "message") continue;
    let connection: Node | null = node.parent;
    while (connection && !(connection.type === "call_expression" && unquote(args(connection)[0]) === "connection")) connection = connection.parent;
    const body = (connection ?? node).text;
    found.push(door("websocket", "WebSocket messages", "websocket message", "POST", file, node, body, /verifyClient/.test(text) || WS_AUTH.test(body) ? ["connection-auth"] : []));
  }
  return found;
}

// tRPC: `deletePost: protectedProcedure.input(...).mutation(async ({ input, ctx }) => ...)`.
function trpcDoors(root: Node, file: string): Door[] {
  const found: Door[] = [];
  for (const node of walk(root)) {
    if (node.type !== "pair" || node.childForFieldName("value")?.type !== "call_expression") continue;
    const call = node.childForFieldName("value")!;
    const kind = member(call)?.property;
    if (kind !== "mutation" && kind !== "query" && kind !== "subscription") continue;
    // Down the chain to the procedure it's built on, collecting .use(middleware) on the way.
    const guards: string[] = [];
    let link: Node | null | undefined = member(call)?.object;
    while (link?.type === "call_expression") {
      const step = member(link);
      if (step?.property === "use") guards.push(...args(link).map((a) => a.text.slice(0, 60)));
      link = step?.object ?? callName(link);
    }
    const base = link?.text ?? "";
    if (!/procedure/i.test(base)) continue;
    if (/admin/i.test(base)) guards.push("admin-auth");
    else if (/protected|private|authed|auth|user|logged/i.test(base)) guards.push("auth");
    const name = node.childForFieldName("key")!.text.replace(/^["']|["']$/g, "");
    found.push(door("trpc", `tRPC procedure "${name}"`, name, kind === "mutation" ? "POST" : "GET", file, node, call.text, guards));
  }
  return found;
}

// GraphQL resolver maps: `Mutation: { cancelRide: (parent, args, context) => ... }`, or a field
// wrapped in a check (`cancelRide: requireAuth(...)`), which counts as its guard.
function graphqlDoors(root: Node, file: string, appGuard: string | undefined): Door[] {
  const found: Door[] = [];
  for (const node of walk(root)) {
    if (node.type !== "pair") continue;
    const type = node.childForFieldName("key")?.text.replace(/^["']|["']$/g, "");
    const fields = node.childForFieldName("value");
    if (!(type === "Query" || type === "Mutation" || type === "Subscription") || fields?.type !== "object") continue;
    for (const field of fields.namedChildren) {
      const value = field.type === "pair" ? field.childForFieldName("value") : field.type === "method_definition" ? field : undefined;
      const name = field.childForFieldName(field.type === "pair" ? "key" : "name")?.text.replace(/^["']|["']$/g, "");
      if (!value || !name) continue;
      const wrapped = value.type === "call_expression" ? callName(value)?.text : undefined;
      if (!isFunction(value) && value.type !== "method_definition" && !wrapped) continue;
      const guards = [...(wrapped ? [wrapped] : []), ...(appGuard ? [appGuard] : [])];
      found.push(door("graphql", `GraphQL ${type === "Mutation" ? "mutation" : type === "Query" ? "query" : "subscription"} "${name}"`, name, type === "Mutation" ? "POST" : "GET", file, field, value.text, guards));
    }
  }
  return found;
}

// Next.js server actions: every exported function of a "use server" file, and any function whose
// body starts with "use server". The browser can call each one with any arguments.
const directive = (body: Node | null | undefined) => {
  const first = body?.namedChildren[0];
  return first?.type === "expression_statement" && /^["']use server["']$/.test(first.text.replace(/;$/, ""));
};
function serverActionDoors(root: Node, file: string, guards: string[]): Door[] {
  const found: Door[] = [];
  const wholeFile = directive(root);
  for (const node of walk(root)) {
    if (!/^(function_declaration|arrow_function|function_expression)$/.test(node.type)) continue;
    const body = node.childForFieldName("body");
    const exported = node.parent?.type === "export_statement" || node.parent?.parent?.parent?.type === "export_statement";
    if (!(directive(body) || (wholeFile && exported))) continue;
    const name = node.childForFieldName("name")?.text ?? (node.parent?.type === "variable_declarator" ? node.parent.childForFieldName("name")?.text : undefined);
    if (!name) continue;
    found.push(door("server-action", `server action "${name}"`, name, "POST", file, node, node.text, guards));
  }
  return found;
}

export async function findDoors(texts: Map<string, string>, usage: Map<string, FileUsage>, allFiles: string[]): Promise<Door[]> {
  const app = appOf(allFiles);
  const appsUsing = (source: RegExp) => new Set([...usage].filter(([, u]) => u.imports.some((i) => source.test(i.source))).map(([file]) => app(file)));
  const [socketApps, trpcApps, graphqlApps, shieldApps] = [SOCKET_IO, TRPC, GRAPHQL_SERVER, GRAPHQL_SHIELD].map(appsUsing);
  const socketAuthApps = new Set([...texts].filter(([file, text]) => socketApps.has(app(file)) && SOCKET_AUTH.test(text)).map(([file]) => app(file)));
  // The GraphQL server works out who's calling for every resolver (context from the request's token).
  const contextAuthApps = new Set([...texts].filter(([file, text]) => graphqlApps.has(app(file)) && GRAPHQL_CONTEXT_AUTH.test(text)).map(([file]) => app(file)));
  // Next.js middleware (proxy.ts since Next 16) that runs auth on every page: server actions post to pages.
  const middlewareAuthApps = new Set([...texts].filter(([file, text]) => NEXT_MIDDLEWARE.test(file) && NEXT_MIDDLEWARE_AUTH.test(text)).map(([file]) => app(file)));
  const imports = (file: string, source: RegExp) => usage.get(file)?.imports.some((i) => source.test(i.source)) ?? false;

  const doors: Door[] = [];
  for (const [file, text] of texts) {
    const id = grammarForFile(file)?.id;
    if (id !== "javascript" && id !== "typescript" && id !== "tsx") continue;
    const where = app(file);
    // Only parse what can hold a door; a browser file using socket.io-client opens none.
    const socket = socketApps.has(where) && !imports(file, /^socket\.io-client$/) && /\.on\(\s*["'`]/.test(text);
    const ws = imports(file, WS) && /\.on\(\s*["']message/.test(text);
    const trpc = trpcApps.has(where) && /\.(mutation|query|subscription)\(/.test(text);
    const graphql = graphqlApps.has(where) && /\b(Query|Mutation|Subscription)\s*:\s*\{/.test(text);
    const actions = /["']use server["']/.test(text);
    if (!socket && !ws && !trpc && !graphql && !actions) continue;
    const tree = await parseSource(text, id);
    try {
      const root = tree.rootNode;
      if (socket && !ws) doors.push(...socketDoors(root, file, socketAuthApps.has(where)));
      if (ws) doors.push(...websocketDoors(root, file, text));
      if (trpc) doors.push(...trpcDoors(root, file));
      if (graphql) doors.push(...graphqlDoors(root, file, shieldApps.has(where) ? "shield-auth" : contextAuthApps.has(where) ? "context-auth" : undefined));
      if (actions) doors.push(...serverActionDoors(root, file, middlewareAuthApps.has(where) ? ["middleware-auth"] : []));
    } finally {
      tree.delete();
    }
  }
  return doors;
}
