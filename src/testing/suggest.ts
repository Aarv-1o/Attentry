import { namedRoutes } from "../agent/plan.ts";
import { parsePath, reaches, type ApiPath } from "../rules/crossStack/paths.ts";
import type { FullRoute } from "../rules/crossStack/resolve.ts";
import { ADMIN, AUTH_GUARD, AUTH_INLINE, handlerCode, PUBLIC_MARK, PUBLIC_PATH } from "../rules/security/endpoints.ts";
import type { ScanResult } from "../scan/scan.ts";
import type { TestedRoute } from "./coverage.ts";

// The tests a plan needs, from the routes it names and what the repo already has. Few and
// worst-risk first (docs/tests-plan.md): a test that reproduces the bug, then who may call a
// route, then that it works. Claude writes them; a route that already has tests gets none.

const MAX = 5;
// A bug, not any "fix": "fix the typo in the README" needs no test that reproduces anything.
const BUG_FIX = /\b(bug|broken|regression|crash(es|ing)?)\b|\bfix(es|ing)?\b[^.\n]*\b(error|wrong|incorrect|fails?|issue)\b/i;
// The whole request body handed to the model: an extra `role` field would be saved too.
const WHOLE_BODY = /\.\.\.\s*req\.body|\b(create|update|insert|insertOne|updateOne|findByIdAndUpdate|save)\(\s*(req\.body|request\.body|body)\b|\*\*\s*(request\.json|payload|body|data|validated_data)\b|\.(model_)?dump\(\)\)/;
const FOR_ADMINS = /\badmins?\b|\bstaff\b|\bsuperusers?\b/i;

interface Suggestion { rank: number; text: string }
// The lines for Claude, and the routes they're for: the change card says which got tests.
export interface PlannedRoute { method: string; path: ApiPath }
export interface TestPlan { lines: string[]; routes: PlannedRoute[] }
interface PlanRoute { method: string; path: ApiPath; said: string; route?: FullRoute }

// The test client each framework is tested with, by what the route's file imports.
const CLIENTS: [RegExp, string][] = [
  [/^fastapi/, "FastAPI's `TestClient(app)`"], [/^flask/, "Flask's `app.test_client()`"],
  [/^(django|rest_framework)/, "Django's test client (`self.client`)"], [/^fastify/, "`app.inject()`"],
  [/^hono/, "`app.request()`"], [/^(express|koa|@koa|@nestjs)/, "supertest (`request(app)`)"],
];

const label = (r: PlanRoute) => `\`${r.method} ${r.path.text}\``;
const same = (a: string, b: string) => a === b || a === "*" || b === "*";

// Is `route` under `parent` (["api", "notes"])? A route mounted where Attentry can't see
// (`…/notes/{id}`) is under it when its known start is the end of `parent`.
function under(route: FullRoute, parent: string[]): boolean {
  const s = route.path.segments;
  if (!route.path.unknownPrefix) return parent.length <= s.length && parent.every((p, i) => same(p, s[i]!));
  for (let k = 1; k < parent.length; k++) {
    const tail = parent.slice(k);
    if (tail.some((p) => p !== "*") && tail.length <= s.length && tail.every((p, i) => same(p, s[i]!))) return true;
  }
  return false;
}

// The routes next to a planned one: under its parent path, else under the one above.
function nearTo(path: ApiPath, routes: FullRoute[]): FullRoute[] {
  for (const cut of [1, 2]) {
    const parent = path.segments.slice(0, -cut);
    const near = parent.length ? routes.filter((r) => under(r, parent)) : [];
    if (near.length) return near;
  }
  return [];
}

// `texts`: the repo's source files, to read handlers named in a route (a controller).
export function suggestTests(plan: string, scan: ScanResult, coverage: TestedRoute[], texts: Map<string, string>): TestPlan {
  const routes = coverage.map((c) => c.route);
  const testsOf = (r: FullRoute) => coverage.find((c) => c.route === r)?.tests ?? [];
  const code = (r: FullRoute) => handlerCode(r, scan.index.functions, texts);
  const authed = (r: FullRoute) => r.guards.some((g) => AUTH_GUARD.test(g)) || AUTH_INLINE.test(code(r));

  const named: PlanRoute[] = namedRoutes(plan).flatMap(({ method, raw, said }) => {
    const path = parsePath(raw);
    if (!path) return [];
    const route = routes.find((r) => (r.method === method || r.method === "ALL") && reaches(path, r.path, "exact"));
    return [{ method, path, said, ...(route ? { route } : {}) }];
  });

  const found: Suggestion[] = [];
  if (BUG_FIX.test(plan)) found.push({ rank: 0, text: "This fixes a bug: first write a test that fails because of it, then fix it. The test keeps it fixed." });
  const untested = named.filter((r) => !(r.route && testsOf(r.route).length)); // tested already: its tests are the place to add to
  for (const r of untested) {
    const near = nearTo(r.path, routes);
    const isPublic = PUBLIC_PATH.test(r.path.text) || (r.route ? r.route.guards.some((g) => PUBLIC_MARK.test(g)) : false);
    const behindLogin = !isPublic && (r.route ? authed(r.route) : near.some(authed));
    const admin = /\/admin(\/|$)/i.test(r.path.text) || FOR_ADMINS.test(r.said) || (r.route ? r.route.guards : near.flatMap((n) => n.guards)).some((g) => ADMIN.test(g));
    if (behindLogin || admin) found.push({ rank: 1, text: `${label(r)}: no login → 401.` });
    if (admin) found.push({ rank: 1, text: `${label(r)}: logged in but not an admin → 403.` });
    // Whether only the owner may do it (edit a note) or anyone may (like a post) is the product's call.
    else if (behindLogin && r.path.segments.includes("*")) found.push({ rank: 1, text: `${label(r)}: if only the owner may do this, another user's id → 403 or 404.` });
    if (r.route && r.method !== "GET" && WHOLE_BODY.test(code(r.route))) found.push({ rank: 2, text: `${label(r)}: an extra field in the body (\`role\`, \`isAdmin\`) isn't saved.` });
    found.push({ rank: 3, text: `${label(r)}: the normal case works (status and the data it returns).` });
  }
  if (!found.length) return { lines: [], routes: [] };
  const lines = found.sort((a, b) => a.rank - b.rank).slice(0, MAX).map((s) => s.text);
  return { lines: [...lines, ...where(untested.length ? untested : named, coverage, scan)], routes: untested.map(({ method, path }) => ({ method, path })) };
}

// At the end of the task: which planned routes now have a test from a file this task edited.
export function plannedWritten(planned: PlannedRoute[], coverage: TestedRoute[], editedFiles: Set<string>): { done: number; missing: string[] } {
  const written = (p: PlannedRoute) => coverage.some((c) =>
    (c.route.method === p.method || c.route.method === "ALL") && reaches(p.path, c.route.path, "exact") && c.tests.some((t) => editedFiles.has(t.file)));
  const missing = planned.filter((p) => !written(p)).map((p) => `${p.method} ${p.path.text}`);
  return { done: planned.length - missing.length, missing };
}

// Where the tests go: the file that tests the routes next to each one, else the framework's client.
function where(named: PlanRoute[], coverage: TestedRoute[], scan: ScanResult): string[] {
  const routes = coverage.map((c) => c.route);
  const fileFor = (r: PlanRoute) => {
    const counts = new Map<string, number>();
    for (const near of nearTo(r.path, routes)) for (const t of coverage.find((c) => c.route === near)!.tests) counts.set(t.file, (counts.get(t.file) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const files = new Map<string, PlanRoute[]>();
  for (const r of named) {
    const file = fileFor(r);
    if (file) files.set(file, [...(files.get(file) ?? []), r]);
  }
  if (files.size === 1) return [`Put them in ${[...files.keys()][0]}, which tests the routes next to these.`];
  if (files.size > 1) return [...files].map(([file, rs]) => `Put the ${rs.map(label).join(" and ")} tests in ${file}, next to the tests of the routes beside it.`);
  // The framework, from what the nearest route's file imports, else what any file does (a router
  // file may use Router() without importing express itself).
  const near = named.length ? nearTo(named[0]!.path, routes)[0] ?? routes[0] : undefined;
  const sourcesOf = (fileNames: string[]) => fileNames.flatMap((f) => scan.index.usage.get(f)?.imports ?? []).map((i) => i.source);
  const clientIn = (sources: string[]) => CLIENTS.find(([pattern]) => sources.some((s) => pattern.test(s)))?.[1];
  const client = clientIn(near ? sourcesOf([near.file]) : []) ?? clientIn(sourcesOf([...scan.index.usage.keys()]));
  return client ? [`No route tests next to these yet: write them with ${client}, so they run without starting the server.`] : [];
}
