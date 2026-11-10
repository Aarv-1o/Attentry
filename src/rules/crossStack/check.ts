import type { Confidence } from "../confidence.ts";
import { hasParams, isCatchAll, parsePath, reaches, type ApiPath } from "./paths.ts";
import { isTestFile } from "../../index/files.ts";
import { callUrl } from "./calls.ts";
import { fullRoutes, type FullRoute } from "./resolve.ts";
import type { ImportInfo } from "../../index/usage.ts";
import type { ApiCall, FileApi } from "./types.ts";

// Frontend and backend drift apart: the frontend calls a route that was renamed or never
// written, or the backend keeps routes nothing calls any more.

export interface MissingRoute {
  kind: "missing-route" | "wrong-method";
  confidence: Confidence;
  file: string;
  line: number;
  method: string | undefined;
  path: ApiPath;
  closest?: FullRoute; // missing-route: the route it most likely meant; wrong-method: the one with that path
  methods?: string[]; // wrong-method: every method the path takes
}

// "The route only takes GET", "The route takes GET and PUT".
export const takes = (m: MissingRoute) => {
  const methods = m.methods ?? [m.closest!.method];
  return methods.length === 1 ? `The route only takes ${methods[0]}` : `The route takes ${methods.slice(0, -1).join(", ")} and ${methods.at(-1)}`;
};

export interface UnusedRoute {
  confidence: Confidence;
  route: FullRoute;
}

export interface CrossStack {
  allRoutes: FullRoute[]; // every route found, for the endpoint security checks
  routes: number;
  calls: number;
  missing: MissingRoute[];
  unused: UnusedRoute[];
}

// Called from outside the app (Stripe, Google, cron, uptime checks, browser redirects), never by its own frontend.
const CALLED_FROM_OUTSIDE = /webhook|callback|oauth|redirect|health|status|ping|cron|tick|docs|openapi|metrics|verify|stream/i;

const methodFits = (call: string | undefined, route: string) => !call || route === "ALL" || call === route;

// A typo of the same word: note / notes, user / users, prof / profile.
const nearWord = (a: string, b: string) => a !== "*" && b !== "*" && a !== b && (a.startsWith(b) || b.startsWith(a));

// The route a call probably meant: same length, most segments in common, at least half. A segment
// that's nearly the same word counts half, so /api/note/:id means /api/notes/:id, not /api/shared/:id.
function closestRoute(path: ApiPath, routes: FullRoute[]): FullRoute | undefined {
  let best: FullRoute | undefined;
  let bestScore = 0;
  for (const route of routes) {
    if (route.path.unknownPrefix || route.path.segments.length !== path.segments.length) continue;
    const score = route.path.segments.reduce((sum, s, i) => sum + (s === path.segments[i] ? 1 : nearWord(s, path.segments[i]!) ? 0.5 : 0), 0);
    if (score > bestScore && score >= path.segments.length / 2) [best, bestScore] = [route, score];
  }
  return best;
}

// The routes a call reaches. A literal segment beats a parameter: `${id}` only stands in for
// "/export" when no route takes a parameter there.
function routesFor(path: ApiPath, routes: FullRoute[]): FullRoute[] {
  const strict = routes.filter((r) => reaches(path, r.path, "strict"));
  return strict.length ? strict : routes.filter((r) => reaches(path, r.path));
}

// Does the match rest on a real word in the path? `…/uppercase` "reaching" `/post/:id` only
// because `:id` takes anything says nothing.
const hasWordInCommon = (call: ApiPath, route: ApiPath) =>
  call.segments.some((s, i) => s !== "*" && route.segments[route.segments.length - call.segments.length + i] === s);

function checkCall(call: ApiCall & { file: string }, hits: FullRoute[], path: ApiPath, routes: FullRoute[]): MissingRoute | undefined {
  if (hits.some((r) => methodFits(call.method, r.method))) return undefined;
  // Tests call the app to check it, sometimes on purpose against routes that don't exist.
  if (isTestFile(call.file)) return undefined;
  const base = { file: call.file, line: call.line, method: call.method, path };
  const solid = path.unknownPrefix ? hits.filter((r) => hasWordInCommon(path, r.path)) : hits;
  if (solid.length) return { kind: "wrong-method", confidence: "likely", ...base, closest: solid[0]!, methods: [...new Set(solid.map((r) => r.method))] };
  // Sure of the namespace (it's under /api like the real routes)? Then likely; otherwise it
  // may go to a server that isn't in this repo.
  const namespace = path.segments[0];
  const sameNamespace = !path.unknownPrefix && routes.some((r) => !r.path.unknownPrefix && r.path.segments[0] === namespace);
  const closest = closestRoute(path, routes);
  return { kind: "missing-route", confidence: sameNamespace ? "likely" : "maybe", ...base, ...(closest ? { closest } : {}) };
}

// `imports`: each file's imports, to follow routers mounted from other files.
export function findCrossStack(
  apis: Map<string, FileApi>, imports: Map<string, ImportInfo[]>, extraCalls: (ApiCall & { file: string })[] = [],
): CrossStack {
  const repo = { apis, imports, files: new Set(apis.keys()) };
  const routes = fullRoutes(repo).filter((r) => !isCatchAll(r.path));
  const calls = [...[...apis].flatMap(([file, api]) => api.calls.map((c) => ({ ...c, file }))), ...extraCalls]
    .map((call) => {
      const url = callUrl(call, call.file, repo);
      return { call, path: url === undefined ? undefined : parsePath(url) };
    })
    .filter((c): c is { call: ApiCall & { file: string }; path: ApiPath } => !!c.path);
  // No backend in the repo, or no frontend calling it: nothing to compare.
  if (!routes.length || !calls.length) return { allRoutes: routes, routes: routes.length, calls: calls.length, missing: [], unused: [] };

  const reached = calls.map(({ call, path }) => ({ call, path, hits: routesFor(path, routes) }));
  const missing = reached.flatMap(({ call, path, hits }) => checkCall(call, hits, path, routes) ?? []);
  // A page a form posts back to (GET /login) is opened by a link, not a call: any call to the same
  // fixed path counts.
  const page = (r: FullRoute) => r.method === "GET" && !hasParams(r.path);
  const mentioned = new Set(
    [...apis.values()].flatMap((api) => api.mentions.flatMap((m) => {
      const path = parsePath(m);
      return path ? routes.filter((r) => reaches(path, r.path, "exact")) : [];
    })),
  );
  const uses = (r: FullRoute) =>
    reached.some(({ call, hits }) => hits.includes(r) && (methodFits(call.method, r.method) || page(r))) ||
    ((r.method === "GET" || r.method === "ALL") && mentioned.has(r));
  const unused = routes
    .filter((r) => !r.path.unknownPrefix && r.path.segments.length && !CALLED_FROM_OUTSIDE.test(r.path.text))
    .filter((r) => !uses(r))
    .map((route): UnusedRoute => {
      // The frontend uses other routes from the same file, just not this one: likely left behind.
      // A file nothing calls at all may serve another client (a mobile app, a script).
      const siblingsUsed = routes.some((r) => r.file === route.file && r !== route && uses(r));
      return { confidence: siblingsUsed ? "likely" : "maybe", route };
    });
  return { allRoutes: routes, routes: routes.length, calls: calls.length, missing, unused };
}
