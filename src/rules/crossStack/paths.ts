// URL paths from both sides of the stack, in one form that can be compared:
// "/users/:id", "/users/{id}", "/users/<int:id>", "/users/[id]" and `/users/${id}` are all
// ["users", "*"].

// Stands in for a part of a URL Attentry can't work out: `${userId}`, or a constant from elsewhere.
export const HOLE = "\u0000";
const PARAM = "*";
const REST = "**"; // matches any number of segments: Express "{*splat}", Next "[...slug]"

export interface ApiPath {
  segments: string[];
  // The URL starts with a value Attentry couldn't read (`${API}/usage`): only the end is known.
  unknownPrefix: boolean;
  text: string; // for people
}

// This machine, or one on the local network (a dev server on 192.168.x.x): the app's own backend.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})(:\d+)?$/;
const FILE_EXTENSION = /\.[a-z0-9]{2,5}$/i; // /data.json, /logo.png: static files, not API routes

function segmentOf(part: string): string {
  if (/^(\{\*\w*\}|\*\w*|\[\.\.\.\w+\]|\[\[\.\.\.\w+\]\]|<path:\w+>)$/.test(part)) return REST;
  if (part.includes(HOLE) || /^(:\w+\??|\{\w+(:[^}]*)?\}|<(\w+:)?\w+>|\[\w+\])$/.test(part)) return PARAM;
  return part;
}

// A URL as written in a call or a route. Returns undefined for anything that isn't a path
// on this app's own server: other hosts, static files, relative links, unreadable values.
export function parsePath(raw: string): ApiPath | undefined {
  let url = raw.trim();
  const host = /^(?:https?:|wss?:)?\/\/([^/]*)/i.exec(url);
  if (host) {
    if (!LOCAL_HOST.test(host[1]!) && !host[1]!.includes(HOLE)) return undefined; // someone else's API
    url = url.slice(host[0].length) || "/";
  }
  let unknownPrefix = false;
  if (url.startsWith(HOLE)) {
    url = url.replace(/^\u0000+/, "");
    unknownPrefix = true;
  }
  url = url.split(/[?#]/)[0]!;
  if (!url.startsWith("/")) return undefined;
  const segments = url.split("/").filter(Boolean).map(segmentOf);
  if (unknownPrefix && !segments.some((s) => s !== PARAM)) return undefined; // nothing known to match on
  if (FILE_EXTENSION.test(segments.at(-1) ?? "")) return undefined;
  const shown = url.split("/").filter(Boolean).join("/").replaceAll(HOLE, "…");
  return { segments, unknownPrefix, text: `${unknownPrefix ? "…" : ""}/${shown}` };
}

export const hasParams = (path: ApiPath) => path.segments.some((s) => s === PARAM || s === REST);

// Always one leading slash: NestJS and Django write "api" and "articles/" without one.
export function joinPaths(prefix: string, path: string): string {
  const parts = [prefix, path].flatMap((p) => p.split("/")).filter(Boolean);
  return `/${parts.join("/")}`;
}

// How sure a match must be. loose: a call's `${id}` could be the route's literal "/export".
// strict: it can't. exact: and a route's ":id" only takes a call's `${id}`, not "stream".
export type Match = "loose" | "strict" | "exact";
const fits = (mode: Match) => (call: string, route: string) =>
  call === route || (route === PARAM && (mode !== "exact" || call === PARAM)) || (mode === "loose" && call === PARAM);

// Does a call to `call` reach `route`? Either may have an unknown start (a base URL from
// elsewhere, a router mounted where Attentry can't see): then only the ends are compared.
export function reaches(call: ApiPath, route: ApiPath, mode: Match = "loose"): boolean {
  const same = fits(mode);
  const rest = route.segments.indexOf(REST);
  const fixed = rest === -1 ? route.segments : route.segments.slice(0, rest);
  if (call.unknownPrefix || route.unknownPrefix) {
    if (rest !== -1) return true; // a catch-all could take it; we can't say it doesn't
    const [a, b] = [call.segments, fixed];
    const known = call.unknownPrefix && route.unknownPrefix ? Math.min(a.length, b.length) : call.unknownPrefix ? a.length : b.length;
    if (a.length < known || b.length < known) return false;
    return a.slice(a.length - known).every((s, i) => same(s, b[b.length - known + i]!));
  }
  if (rest === -1 ? call.segments.length !== fixed.length : call.segments.length < fixed.length) return false;
  return fixed.every((s, i) => same(call.segments[i]!, s));
}

// A route that only catches everything ("/{*splat}" serving the frontend) says nothing about the API.
export const isCatchAll = (route: ApiPath) => route.segments[0] === REST;
