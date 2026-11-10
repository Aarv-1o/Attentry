import { pathToRegexp } from "path-to-regexp";
import { isNextAuthMiddleware } from "./doors.ts";

// Next.js middleware.ts (proxy.ts since Next 16) runs before the routes its `matcher` lists. When it
// turns away callers who aren't logged in, the routes it matches are protected; the routes it
// doesn't match get nothing from it. Anything less clear (no matcher, a matcher we can't read, auth
// that depends on the path inside the middleware) is "unsure": the route is worth a check.

export type Coverage = "covered" | "not-covered" | "unsure";

// Signs the middleware stops a caller who isn't logged in, not only reads who they are.
const BLOCKS = /NextResponse\.redirect|Response\.redirect|redirectToSignIn|\.protect\(|withAuth\(|status\s*:\s*40[13]\b/;
// NextAuth's `export { auth as middleware }` blocks through an `authorized` callback in its config.
const AUTHORIZED_CALLBACK = /\bauthorized\s*(\(\s*\{|:\s*(async\s*)?\()/;
// Which paths are protected is decided inside the middleware: it can't be read from the matcher alone.
const DECIDES_BY_PATH = /createRouteMatcher|\.pathname\b/; // not req.url: new URL("/login", req.url) is only where to send them

// The matcher's patterns, or undefined when it isn't plain strings (built from variables).
function matchers(text: string): string[] | undefined {
  const value = /\bmatcher\s*:\s*(\[[\s\S]*?\]|"[^"]*"|'[^']*'|`[^`]*`)/.exec(text)?.[1];
  if (!value) return undefined;
  const strings = [...value.matchAll(/(?:source\s*:\s*)?(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]!);
  const rest = value.replace(/(["'`])(?:(?!\1).)*\1/g, "").replace(/\bsource\s*:|\bmissing\s*:|\bhas\s*:|[\s,[\]{}:]/g, "");
  return strings.length && !rest ? strings : undefined;
}

// A URL that reaches this route: [id] and :id become a value.
const sampleUrl = (segments: string[]) => `/${segments.map((s) => (s === "*" ? "x" : s)).join("/")}`;

export function nextMiddlewareCoverage(texts: Map<string, string>, app: (file: string) => string) {
  const byApp = new Map<string, { file: string; patterns: RegExp[] | undefined; blocks: boolean }>();
  const authorizedApps = new Set([...texts].filter(([, text]) => AUTHORIZED_CALLBACK.test(text)).map(([file]) => app(file)));
  for (const [file, text] of texts) {
    if (!isNextAuthMiddleware(file, text)) continue;
    const found = matchers(text);
    let patterns: RegExp[] | undefined;
    try {
      patterns = found?.map((p) => pathToRegexp(p));
    } catch {
      patterns = undefined; // a pattern path-to-regexp can't read: unsure
    }
    const blocks = !DECIDES_BY_PATH.test(text) && (BLOCKS.test(text) || authorizedApps.has(app(file)));
    byApp.set(app(file), { file, patterns, blocks });
  }
  return {
    file: (routeFile: string) => byApp.get(app(routeFile))?.file,
    of(routeFile: string, segments: string[]): Coverage | undefined {
      const mw = byApp.get(app(routeFile));
      if (!mw) return undefined;
      if (!mw.patterns) return "unsure";
      const url = sampleUrl(segments);
      if (!mw.patterns.some((p) => p.test(url))) return "not-covered";
      return mw.blocks ? "covered" : "unsure";
    },
  };
}
