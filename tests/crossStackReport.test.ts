import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCrossStack } from "../src/report/crossStack.ts";
import type { CrossStack } from "../src/rules/crossStack/check.ts";
import { parsePath } from "../src/rules/crossStack/paths.ts";

const route = (method: string, path: string, file: string, line: number) => ({ method, path: parsePath(path)!, file, line, guards: [] });
const found: CrossStack = {
  allRoutes: [],
  routes: 3,
  calls: 4,
  missing: [
    { kind: "missing-route", confidence: "likely", file: "src/a.ts", line: 4, method: "GET", path: parsePath("/api/user/\u0000")!, closest: route("GET", "/api/users/:id", "server/users.js", 5) },
    { kind: "wrong-method", confidence: "likely", file: "src/a.ts", line: 9, method: "POST", path: parsePath("/api/users")!, closest: route("GET", "/api/users", "server/users.js", 3) },
    { kind: "missing-route", confidence: "maybe", file: "src/b.ts", line: 2, method: "GET", path: parsePath("/other/x")! },
  ],
  unused: [{ confidence: "likely", route: route("DELETE", "/api/users/:id", "server/users.js", 9), calls: 4 }],
};

test("cross-stack report: each kind with locations and the route it likely meant; hints hidden", () => {
  const text = formatCrossStack(found, false);
  assert.match(text, /^Frontend and backend \(4 calls checked against 3 routes\)/);
  assert.match(text, /src\/a\.ts:4 {2}GET \/api\/user\/… {2}No such route\. Did you mean GET \/api\/users\/:id \(server\/users\.js:5\)\?/);
  assert.match(text, /Calls with the wrong method \(1\)\n {5}src\/a\.ts:9 {2}POST \/api\/users {2}The route only takes GET \(server\/users\.js:3\)\./);
  assert.match(text, /Routes nothing calls \(1\)\n {5}server\/users\.js:9 {2}DELETE \/api\/users\/:id\n {5}→ Delete it/);
  assert.match(text, /1 more hint hidden/);
  assert.doesNotMatch(text, /\/other\/x/);
  assert.match(formatCrossStack(found, true), /src\/b\.ts:2 {2}GET \/other\/x {2,}No route in this repo has this path\./);
});

test("cross-stack report: says what it checked, or why it didn't", () => {
  assert.equal(formatCrossStack({ allRoutes: [], routes: 3, calls: 4, missing: [], unused: [] }, false), "No frontend/backend mismatches found (4 calls checked against 3 routes).\n");
  assert.equal(formatCrossStack({ allRoutes: [], routes: 0, calls: 4, missing: [], unused: [] }, false), "Frontend and backend: not checked (no API routes found in this repo).\n");
  assert.equal(formatCrossStack({ allRoutes: [], routes: 2, calls: 0, missing: [], unused: [] }, false), "Frontend and backend: not checked (no calls to its API found in this repo).\n");
});
