// What one file says about the HTTP API: the routes it serves and the calls it makes.
// Each language adapter fills this in; the cross-stack check joins all files together.

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface Route {
  method: string; // GET, POST... or ALL
  path: string; // as written, before any prefix from where its router is mounted
  router: string; // the variable it's declared on: "app", "router"
  line: number;
  handler?: string;
  // Middleware named on the route itself: `router.post("/x", protect, admin, handler)` -> [protect, admin].
  // Python: decorators (@login_required) and dependencies (Depends(get_current_user)).
  guards: string[];
  body?: string; // the handler's code, when it's written inline: checks inside it count too
}

// `app.use("/api/auth", authRouter)`, `app.include_router(router, prefix="/v1")`
export interface Mount {
  prefix: string;
  on: string; // the app or router it's mounted on
  target: string; // as written: "authRouter", "createAuthRouter", "chat.router"
  line: number;
  // Middleware between the prefix and the target: app.use("/api/admin", adminAuth, router).
  // When the target isn't a router (app.use(requireAuth)), it's middleware too.
  guards: string[];
}

export interface ApiCall {
  method: string | undefined; // undefined: set by a value Attentry can't read
  url: string; // with HOLE where a value couldn't be worked out
  line: number;
  // Called on an object (`api.get("/users")`): its base URL, if it's a client, is added later.
  // `client`: named like one, so it's a call even if Attentry can't find where it was made.
  via?: { name: string; client: boolean };
}

export interface FileApi {
  routes: Route[];
  mounts: Mount[];
  // Routers and apps created in this file, with their own prefix: APIRouter(prefix="/api") -> "/api".
  // `isApp` for the top level (express(), FastAPI(), Flask()): it isn't mounted anywhere.
  // `global`: gets the app's global prefix (NestJS controllers).
  // `guards`: for every route on it (FastAPI APIRouter(dependencies=[...])).
  routers: Map<string, { prefix: string; isApp: boolean; global?: boolean; guards?: string[] }>;
  globalPrefix?: string; // NestJS app.setGlobalPrefix("api")
  // Guards for every route in the app: NestJS useGlobalGuards / APP_GUARD, DRF default permissions.
  globalGuards: string[];
  // Python views defined here, with their guards: routes in urls.py point at them by name.
  views: Map<string, { guards: string[]; body: string }>;
  // Guards for routes elsewhere, by path or by folder: NestJS consumer.apply(Auth).forRoutes(...),
  // Fastify autohooks.ts (every route file in its folder and below).
  pathGuards: { path: string; method: string; names: string[] }[];
  folderGuards: string[];
  autohooks?: boolean; // an @fastify/autoload autohooks file
  clients: Map<string, string>; // HTTP client instances and their base URL: { api: "http://localhost:8000" }
  // Dev-server proxies (Vite): calls under `prefix` reach the backend with it replaced by `to`.
  proxies: { prefix: string; to: string }[];
  calls: ApiCall[];
  // Other URLs in frontend code: <video src>, <a href>, url={...}. They show a GET route is
  // used, but aren't calls: "/dashboard" may be a frontend page.
  mentions: string[];
}

export const emptyApi = (): FileApi => ({ routes: [], mounts: [], routers: new Map(), clients: new Map(), proxies: [], calls: [], mentions: [], globalGuards: [], views: new Map(), pathGuards: [], folderGuards: [] });
