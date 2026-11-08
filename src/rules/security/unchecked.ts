import type { FileUsage } from "../../index/usage.ts";
import type { DoorKind } from "./doors.ts";

// Packages that open doors to the outside (socket events, GraphQL queries, RPC calls, routes in a
// framework Attentry doesn't read) whose handlers the endpoint checks (login, owner, rate limit)
// don't see yet. A repo that uses one hears so: "no security issues" would otherwise read as
// "checked and fine". Client libraries (socket.io-client) open no door and aren't listed.

export const CHECKED_BACKENDS = "Express, Koa, Hono, Fastify, NestJS, Next.js, FastAPI, Flask and Django";

// With the kind of door Attentry reads for it (doors.ts): listed only when none of that kind was
// found, so a style it can't read still says "not checked".
const UNCHECKED: [RegExp, string, DoorKind?][] = [
  [/^socket\.io$/, "Socket.io event handlers", "socket"],
  [/^(ws|uWebSockets\.js)$/, "WebSocket handlers", "websocket"],
  [/^@trpc\/server(\/|$)/, "tRPC procedures", "trpc"],
  [/^(graphql|@apollo\/server|apollo-server(-[\w-]+)?|graphql-yoga|mercurius|@graphql-tools\/schema)$/, "GraphQL resolvers", "graphql"],
  [/^(type-graphql|@nestjs\/graphql|@pothos\/core)$/, "GraphQL resolvers written as classes or builders (type-graphql, NestJS, Pothos)"],
  [/^(graphene|strawberry|ariadne)(\.|$)/, "Python GraphQL resolvers"],
  [/^channels(\.|$)|^websockets(\.|$)/, "Python WebSocket handlers"],
  [/^@hapi\/hapi$/, "hapi routes"],
  [/^restify$/, "restify routes"],
  [/^@adonisjs\/core(\/|$)/, "AdonisJS routes"],
  [/^elysia$/, "Elysia routes"],
  [/^h3$/, "h3 / Nitro routes"],
  [/^@loopback\/rest$/, "LoopBack routes"],
  [/^(tornado|aiohttp|sanic|litestar)(\.|$)/, "Python web routes (tornado, aiohttp, sanic or litestar)"],
];

export interface UncheckedDoors {
  label: string;
  files: string[];
}

export function uncheckedDoors(usage: Map<string, FileUsage>, read: Set<DoorKind> = new Set()): UncheckedDoors[] {
  const found = new Map<string, Set<string>>();
  for (const [file, { imports }] of usage) {
    for (const i of imports) {
      const label = UNCHECKED.find(([source, , kind]) => source.test(i.source) && !(kind && read.has(kind)))?.[1];
      if (label) found.set(label, (found.get(label) ?? new Set()).add(file));
    }
  }
  // In the list's order, whatever order the files were read in.
  return UNCHECKED.flatMap(([, label]) => (found.has(label) ? [{ label, files: [...found.get(label)!].sort() }] : []));
}

const MAX_FILES = 3;
export function formatUnchecked(doors: UncheckedDoors[]): string {
  if (!doors.length) return "";
  const list = doors.map((d) => `  ${d.label}: ${d.files.slice(0, MAX_FILES).join(", ")}${d.files.length > MAX_FILES ? ` and ${d.files.length - MAX_FILES} more` : ""}`);
  return `Not checked for security yet:\n${list.join("\n")}\n  → Attentry checks routes in ${CHECKED_BACKENDS}. Check who may call these by hand (login, whose data), or ask your agent to.\n`;
}
