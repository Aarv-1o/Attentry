import { posix } from "node:path";
import { HOLE, joinPaths, parsePath, type ApiPath } from "./paths.ts";
import type { ImportInfo } from "../../index/usage.ts";
import type { FileApi } from "./types.ts";

// Joins every file's routes and mounts into full paths: a route "/signup" on a router mounted
// at "/api/auth" in another file is POST /api/auth/signup.

export interface FullRoute {
  method: string;
  path: ApiPath; // unknownPrefix when Attentry couldn't find where its router is mounted
  file: string;
  line: number;
  handler?: string;
  // Every middleware, guard, dependency or decorator in front of the handler, from the route
  // itself up through each router it's mounted on, plus global guards.
  guards: string[];
  body?: string; // the handler's code, when it's known
}

const JS_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];

// The file an import points at, if it's in the repo. "./auth.js" may be auth.ts (TS ESM).
export function resolveModule(from: string, source: string, files: Set<string>): string | undefined {
  if (from.endsWith(".py")) return resolvePython(from, source, files);
  let base: string;
  if (source.startsWith(".")) base = posix.join(posix.dirname(from), source);
  else if (/^[@~]\//.test(source)) base = `src/${source.slice(2)}`;
  else return undefined; // a package
  const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
  return [base, ...JS_EXTENSIONS.map((ext) => stem + ext)].find((f) => files.has(f));
}

function resolvePython(from: string, source: string, files: Set<string>): string | undefined {
  const dots = /^\.*/.exec(source)![0].length;
  const rest = source.slice(dots).replaceAll(".", "/");
  if (dots) {
    let dir = posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    const path = posix.join(dir, rest);
    return [`${path}.py`, `${path}/__init__.py`].find((f) => files.has(f));
  }
  // Absolute: the repo may be scanned from a folder above the project, so match the end.
  const candidates = [`${rest}.py`, `${rest}/__init__.py`];
  return [...files]
    .filter((f) => candidates.some((c) => f === c || f.endsWith(`/${c}`)))
    .sort((a, b) => a.length - b.length)[0];
}

type Key = string; // "file#variable"
const keyOf = (file: string, name: string): Key => `${file}#${name}`;

export interface Repo {
  apis: Map<string, FileApi>;
  imports: Map<string, ImportInfo[]>;
  files: Set<string>;
}

// Where a name used in `file` comes from: `chatRouter` imported from "./chat" as `router`
// is { file: "routes/chat.ts", name: "router" }. `chat.router` (a module's attribute) works too.
export function definedIn(file: string, target: string, { imports, files }: Repo): { file: string; name: string | undefined } | undefined {
  // "require:./auth" (a module), or "require:app.urls:urlpatterns" (a name in it)
  const [, required, requiredName] = /^require:([^:]*)(?::(\w+))?$/.exec(target) ?? [];
  const [local, attribute] = target.split(".");
  let source: string;
  let name: string | undefined;
  if (required) [source, name] = [required, requiredName];
  else {
    const from = imports.get(file)?.find((i) => local! in i.bound);
    if (!from) return undefined;
    const bound = from.bound[local!]!;
    if (attribute) {
      // chat.router, after `from app.api import chat` or `import app.api.chat as chat`
      source = bound === "*" ? from.source : `${from.source}.${bound}`;
      name = attribute;
    } else [source, name] = [from.source, bound];
  }
  const into = resolveModule(file, source, files);
  return into ? { file: into, name } : undefined;
}

// The routers a mount points at: a router in this file, or an imported one (or a factory
// that makes one, or a plugin that's handed one: then the routers in that file).
function mountTargets(file: string, target: string, repo: Repo): Key[] {
  if (repo.apis.get(file)!.routers.has(target)) return [keyOf(file, target)];
  const from = definedIn(file, target, repo);
  const other = from && repo.apis.get(from.file);
  if (!other) return [];
  if (from.name && other.routers.has(from.name)) return [keyOf(from.file, from.name)];
  const routers = [...other.routers];
  const pick = routers.some(([, r]) => !r.isApp) ? routers.filter(([, r]) => !r.isApp) : routers;
  // A Fastify plugin declares routes on the instance it's given: `fastify.get(...)`.
  const names = pick.length ? pick.map(([n]) => n) : [...new Set(other.routes.map((r) => r.router))];
  return names.map((n) => keyOf(from.file, n));
}

// One way a router is reached: its full path prefix, and the routers above it with the line
// where the next one down was attached (middleware only applies to what's added after it).
interface Reach {
  path: string;
  chain: { key: Key; path: string; line: number; guards: string[] }[];
}

const startsWithPath = (path: string, prefix: string) =>
  prefix === "" || prefix === "/" || path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);

export function fullRoutes(repo: Repo): FullRoute[] {
  const { apis } = repo;
  const globalPrefix = [...apis.values()].find((a) => a.globalPrefix !== undefined)?.globalPrefix ?? "";
  const globalGuards = [...apis.values()].flatMap((a) => a.globalGuards);
  const views = new Map([...apis.values()].flatMap((a) => [...a.views]));
  const pathGuards = [...apis.values()].flatMap((a) => a.pathGuards);
  const folderGuards = [...apis].flatMap(([f, a]) => a.folderGuards.map((name) => ({ dir: posix.dirname(f), name })));
  // NestJS forRoutes paths are relative to the global prefix; a controller name means all its routes.
  const byPath = (route: { method: string; router: string }, path: string) =>
    pathGuards.filter((g) => {
      if (g.path.startsWith("controller:")) return g.path.slice(11) === route.router;
      const want = parsePath(joinPaths(globalPrefix, g.path));
      const have = parsePath(path);
      const sameMethod = g.method === "ALL" || g.method === route.method;
      return !!want && !!have && sameMethod && want.segments.length === have.segments.length && want.segments.every((s, i) => s === have.segments[i] || s === "*" || have.segments[i] === "*");
    }).flatMap((g) => g.names);
  const inFolder = (file: string) => folderGuards.filter((g) => file.startsWith(`${g.dir}/`)).map((g) => g.name);
  const mountedAt = new Map<Key, { on: Key; prefix: string; line: number; guards: string[] }[]>();
  // app.use(requireAuth), router.use("/admin", isAdmin): middleware, not routers.
  const uses = new Map<Key, { prefix: string; line: number; names: string[] }[]>();
  for (const [file, api] of apis) {
    for (const mount of api.mounts) {
      const targets = mountTargets(file, mount.target, repo);
      const on = keyOf(file, mount.on);
      if (!targets.length) {
        uses.set(on, [...(uses.get(on) ?? []), { prefix: mount.prefix, line: mount.line, names: [...mount.guards, mount.target] }]);
      }
      for (const target of targets) {
        mountedAt.set(target, [...(mountedAt.get(target) ?? []), { on, prefix: mount.prefix, line: mount.line, guards: mount.guards }]);
      }
    }
  }
  const split = (key: Key) => [key.slice(0, key.lastIndexOf("#")), key.slice(key.lastIndexOf("#") + 1)] as const;
  // Every way a router is reached; undefined when it's never mounted anywhere we can see.
  const reaches = (key: Key, seen = new Set<Key>()): Reach[] | undefined => {
    if (seen.has(key)) return undefined;
    seen.add(key);
    const [file, name] = split(key);
    const router = apis.get(file)?.routers.get(name);
    const own = router?.global ? joinPaths(globalPrefix, router.prefix) : (router?.prefix ?? "");
    const parents = (mountedAt.get(key) ?? []).flatMap((m) =>
      (reaches(m.on, new Set(seen)) ?? []).map((up) => {
        const path = joinPaths(joinPaths(up.path, m.prefix), own);
        const last = up.chain.at(-1)!;
        return { path, chain: [...up.chain.slice(0, -1), { ...last, line: m.line, guards: [...last.guards, ...m.guards] }, { key, path, line: 0, guards: [] }] };
      }),
    );
    if (parents.length) return parents;
    return router?.isApp || (!router && name === "app") ? [{ path: own, chain: [{ key, path: own, line: 0, guards: [] }] }] : undefined;
  };

  // Guards on the way to a route: each router's own, the middleware it uses before the next
  // step (whose prefix covers the route), and what each mount adds.
  const guardsFor = (chain: Reach["chain"], routeLine: number, routePath: string) =>
    chain.flatMap((step, i) => {
      const [file, name] = split(step.key);
      const before = i === chain.length - 1 ? routeLine : step.line;
      const used = (uses.get(step.key) ?? []).filter((u) => u.line < before && startsWithPath(routePath, joinPaths(step.path, u.prefix)));
      return [...(apis.get(file)?.routers.get(name)?.guards ?? []), ...used.flatMap((u) => u.names), ...step.guards];
    });

  const routes: FullRoute[] = [];
  for (const [file, api] of apis) {
    for (const route of api.routes) {
      const key = keyOf(file, route.router);
      const found = reaches(key) ?? [{ path: HOLE, chain: [{ key, path: HOLE, line: 0, guards: [] }] }];
      const view = route.handler ? views.get(route.handler) : undefined;
      for (const reach of found) {
        // A prefix with an unknown part (a setting): only what comes after it is known.
        const raw = reach.path.includes(HOLE) ? HOLE + joinPaths(reach.path.split(HOLE).at(-1)!, route.path) : joinPaths(reach.path, route.path);
        const path = parsePath(raw);
        if (!path) continue;
        const guards = [
          ...guardsFor(reach.chain, route.line, raw), ...route.guards, ...(view?.guards ?? []),
          ...byPath(route, raw), ...inFolder(file), ...globalGuards,
        ];
        const body = route.body ?? view?.body;
        routes.push({ method: route.method, path, file, line: route.line, guards, ...(route.handler ? { handler: route.handler } : {}), ...(body ? { body } : {}) });
      }
    }
  }
  return routes;
}
