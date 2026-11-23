import { isTestFile } from "../index/files.ts";
import type { RepoIndex } from "../index/repo.ts";
import { hasWordInCommon, methodFits, routesFor } from "../rules/crossStack/check.ts";
import { HOLE, isCatchAll, parsePath, type ApiPath } from "../rules/crossStack/paths.ts";
import { definedIn, fullRoutes, resolveModule, type FullRoute, type Repo } from "../rules/crossStack/resolve.ts";
import type { ApiCall, FileApi } from "../rules/crossStack/types.ts";

// Which routes the repo's tests reach, and from where. A test reaches a route by sending it a
// request in-process (supertest, TestClient...), or, for Next.js, by importing its handler.
// Only routes are counted, never lines: an untested route is something a person can act on.

export interface TestedRoute {
  route: FullRoute;
  tests: { file: string; line: number }[]; // empty: no test reaches it
}

const literals = (route: FullRoute) => route.path.segments.filter((s) => s !== "*" && s !== "**").length;

function matching(path: ApiPath, method: string | undefined, routes: FullRoute[]): FullRoute[] {
  let hits = routesFor(path, routes).filter((r) => methodFits(method, r.method));
  // With an unknown start on either side (`f"{settings.API_V1_STR}/items/"`), only path ends are
  // compared, so `…/items` would "reach" `…/users/{id}` and `…/private/users`. Keep matches that
  // share a real word, and when a route is as long as the call, only those.
  if (path.unknownPrefix || hits.some((r) => r.path.unknownPrefix)) {
    hits = hits.filter((r) => hasWordInCommon(path, r.path));
    const sameLength = hits.filter((r) => r.path.segments.length === path.segments.length);
    if (sameLength.length) hits = sameLength;
  }
  // The server sends /users/me to the /users/me route, not /users/{id}: the most specific wins.
  const best = Math.max(...hits.map(literals));
  return hits.filter((r) => literals(r) === best);
}

// reverse("note-detail") names the route; "notes:note-detail" also matches a test that leaves
// out the namespace.
const sameName = (want: string, route: FullRoute) => route.name === want || (!want.includes(":") && route.name?.endsWith(`:${want}`));

function routesReached(call: ApiCall, file: string, routes: FullRoute[], repo: Repo): FullRoute[] {
  if (call.routeName) return routes.filter((r) => sameName(call.routeName!, r) && methodFits(call.method, r.method));
  const path = parsePath(call.url);
  const direct = path ? matching(path, call.method, routes) : [];
  if (direct.length || !call.app) return direct;
  // Sent to one router imported on its own (Hono's api.request("/posts")): its routes, under
  // whatever prefix it's mounted at.
  const from = definedIn(file, call.app, repo);
  const bare = from && parsePath(HOLE + call.url);
  return bare ? matching(bare, call.method, routes.filter((r) => r.file === from.file)) : [];
}

// Next.js route tests: `import { GET } from "@/app/api/notes/route"`, then GET(request).
function importedHandlers(repo: Repo, file: string, routes: FullRoute[]) {
  return (repo.imports.get(file) ?? []).flatMap((imp) => {
    const target = resolveModule(file, imp.source, repo.files);
    const names = new Set(Object.values(imp.bound));
    return routes
      .filter((r) => r.file === target && (names.has(r.method) || (r.method === "ALL" && names.has("default"))))
      .map((route) => ({ route, at: { file, line: imp.line } }));
  });
}

export function routeCoverage(index: RepoIndex): TestedRoute[] {
  const apis = new Map<string, FileApi>([...index.scans].map(([file, s]) => [file, s.api]));
  const repo: Repo = { apis, imports: new Map([...index.usage].map(([file, u]) => [file, u.imports])), files: new Set(apis.keys()) };
  const product = fullRoutes({ ...repo, apis: new Map([...apis].filter(([file]) => !isTestFile(file))) }).filter((r) => !isCatchAll(r.path));
  // A test may build its own app around a router: `app.use("/notes", notes)` in the test file.
  // Paths through those apps are matched too, and count for the real route they stand for.
  const keyOf = (r: FullRoute) => `${r.file}:${r.line}:${r.method}`;
  const real = new Map<string, FullRoute[]>();
  for (const r of product) real.set(keyOf(r), [...(real.get(keyOf(r)) ?? []), r]);
  // The same route mounted twice is two real routes: a real path counts for its own, a path
  // through a test's app for both.
  const standsFor = (hit: FullRoute) => {
    const all = real.get(keyOf(hit))!;
    const same = all.filter((r) => r.path.text === hit.path.text);
    return same.length ? same : all;
  };
  const paths = fullRoutes(repo).filter((r) => real.has(keyOf(r)));
  const reached = new Map<FullRoute, { file: string; line: number }[]>(product.map((r) => [r, []]));
  for (const [file, scan] of index.scans) {
    if (!isTestFile(file)) continue;
    for (const call of scan.testCalls) {
      const hits = new Set(routesReached(call, file, paths, repo).flatMap(standsFor));
      for (const route of hits) reached.get(route)!.push({ file, line: call.line });
    }
    for (const { route, at } of importedHandlers(repo, file, product)) reached.get(route)!.push(at);
  }
  return [...reached].map(([route, tests]) => ({ route, tests }));
}
