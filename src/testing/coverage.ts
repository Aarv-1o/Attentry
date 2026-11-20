import { isTestFile } from "../index/files.ts";
import type { RepoIndex } from "../index/repo.ts";
import { methodFits, routesFor } from "../rules/crossStack/check.ts";
import { isCatchAll, parsePath } from "../rules/crossStack/paths.ts";
import { fullRoutes, resolveModule, type FullRoute } from "../rules/crossStack/resolve.ts";
import type { FileApi } from "../rules/crossStack/types.ts";

// Which routes the repo's tests reach, and from where. A test reaches a route by sending it a
// request in-process (supertest, TestClient...), or, for Next.js, by importing its handler.
// Only routes are counted, never lines: an untested route is something a person can act on.

export interface TestedRoute {
  route: FullRoute;
  tests: { file: string; line: number }[]; // empty: no test reaches it
}

// Next.js route tests: `import { GET } from "@/app/api/notes/route"`, then GET(request).
function importedHandlers(index: RepoIndex, file: string, routes: FullRoute[], files: Set<string>) {
  return (index.usage.get(file)?.imports ?? []).flatMap((imp) => {
    const target = resolveModule(file, imp.source, files);
    const names = new Set(Object.values(imp.bound));
    return routes
      .filter((r) => r.file === target && (names.has(r.method) || (r.method === "ALL" && names.has("default"))))
      .map((route) => ({ route, at: { file, line: imp.line } }));
  });
}

export function routeCoverage(index: RepoIndex): TestedRoute[] {
  const apis = new Map<string, FileApi>([...index.scans].map(([file, s]) => [file, s.api]));
  const files = new Set(apis.keys());
  const repo = { apis, imports: new Map([...index.usage].map(([file, u]) => [file, u.imports])), files };
  const routes = fullRoutes(repo).filter((r) => !isCatchAll(r.path));
  const reached = new Map<FullRoute, { file: string; line: number }[]>(routes.map((r) => [r, []]));
  for (const [file, scan] of index.scans) {
    if (!isTestFile(file)) continue;
    for (const call of scan.testCalls) {
      const path = parsePath(call.url);
      if (!path) continue;
      for (const route of routesFor(path, routes)) {
        if (methodFits(call.method, route.method)) reached.get(route)!.push({ file, line: call.line });
      }
    }
    for (const { route, at } of importedHandlers(index, file, routes, files)) reached.get(route)!.push(at);
  }
  return [...reached].map(([route, tests]) => ({ route, tests }));
}
