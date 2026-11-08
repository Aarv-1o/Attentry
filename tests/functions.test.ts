import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFunctions, type FunctionInfo } from "../src/index/functions.ts";
import { parseSource, type LanguageId } from "../src/parse/parse.ts";

async function extract(source: string, language: LanguageId): Promise<FunctionInfo[]> {
  const tree = await parseSource(source, language);
  try {
    return extractFunctions({ path: "x", language, source, tree }, "x");
  } finally {
    tree.delete();
  }
}

const byName = (fns: FunctionInfo[]) => Object.fromEntries(fns.map((f) => [f.name, f]));

test("JS/TS: finds every named function form", async () => {
  const fns = byName(await extract(`
export function timeAgo(dateStr) { return dateStr; }
const formatSize = (bytes, { unit = "B" } = {}) => bytes;
export const fetchItems = async function (page = 1, ...rest) { await page; };
class Registry {
  has(type) { return this.map.has(type); }
}
const api = { load(id) { return id; } };
[1, 2].map((x) => x * 2); // anonymous: not indexed
`, "typescript"));

  assert.deepEqual(Object.keys(fns).sort(), ["fetchItems", "formatSize", "has", "load", "timeAgo"]);
  assert.deepEqual(fns.timeAgo?.params, ["dateStr"]);
  assert.deepEqual(fns.formatSize?.params, ["bytes", "{ unit = \"B\" }"]);
  assert.deepEqual(fns.fetchItems?.params, ["page", "...rest"]);
  assert.equal(fns.fetchItems?.async, true);
  assert.equal(fns.has?.className, "Registry");
  assert.equal(fns.timeAgo?.startLine, 2);
});

test("JS: knows what is exported, in every export style", async () => {
  const fns = byName(await extract(`
export function a() {}
function b() {}
function c() {}
function d() {}
function e() {}
function hidden() {}
export { b };
export default c;
module.exports.d = d;
exports.e = e;
`, "javascript"));
  for (const name of ["a", "b", "c", "d", "e"]) assert.equal(fns[name]?.exported, true, `${name} should be exported`);
  assert.equal(fns.hidden?.exported, false);
});

test("JS: a function inside an exported one isn't exported (a component's own handler)", async () => {
  const all = await extract(`
export default function RiderApp() {
  function cancelRide() {}
  const pick = () => {};
  return null;
}
export const DriverApp = () => {
  function cancelRide() {}
  return null;
};
export const arrow = () => 1;
`, "javascript");
  const exported = (name: string) => all.filter((f) => f.name === name).map((f) => f.exported);
  assert.deepEqual(exported("RiderApp"), [true]);
  assert.deepEqual(exported("arrow"), [true]);
  assert.deepEqual(exported("pick"), [false]);
  assert.deepEqual(exported("cancelRide"), [false, false]);
});

test("JS: module.exports object counts as exported", async () => {
  const fns = byName(await extract("function a() {}\nconst b = () => 1;\nmodule.exports = { a, b: b };", "javascript"));
  assert.equal(fns.a?.exported, true);
  assert.equal(fns.b?.exported, true);
});

test("TSX: components are functions too", async () => {
  const fns = await extract("export const Card = ({ title }: { title: string }) => <h2>{title}</h2>;", "tsx");
  assert.equal(fns[0]?.name, "Card");
  assert.equal(fns[0]?.exported, true);
});

test("Python: functions, methods, decorators and public names", async () => {
  const fns = byName(await extract(`
import functools

def strip_json_state(text: str, *, strict=False) -> str:
    return text

def _helper(x):
    return x

@functools.cache
async def fetch(url, timeout: int = 5, *args, **kwargs):
    return url

class Planner:
    def plan(self, state):
        def inner():
            pass
        return state
`, "python"));
  assert.deepEqual(fns.strip_json_state?.params, ["text", "strict"]);
  assert.equal(fns.strip_json_state?.exported, true);
  assert.equal(fns._helper?.exported, false);
  assert.equal(fns.fetch?.exported, true, "decorated top-level function is public");
  assert.equal(fns.fetch?.async, true);
  assert.deepEqual(fns.fetch?.params, ["url", "timeout", "*args", "**kwargs"]);
  assert.equal(fns.plan?.className, "Planner");
  assert.equal(fns.plan?.exported, false);
  assert.equal(fns.inner?.exported, false);
});

test("records how each function gets called", async () => {
  const js = byName(await extract(`
export default function Page() {}
function helper() {}
class Store { load() {} }
const tool = { handler() {}, run: async () => {} };
`, "tsx"));
  assert.equal(js.Page?.defaultExport, true);
  assert.equal(js.helper?.kind, "function");
  assert.equal(js.load?.kind, "method");
  assert.equal(js.handler?.kind, "property");
  assert.equal(js.run?.kind, "property");

  const named = byName(await extract("function App() {}\nexport default App;\n", "javascript"));
  assert.equal(named.App?.defaultExport, true);

  const py = byName(await extract('@app.get("/")\ndef root():\n    pass\n\ndef plain():\n    pass\n', "python"));
  assert.equal(py.root?.decorated, true);
  assert.equal(py.plain?.decorated, false);
});

test("records nesting depth, unused params and use as a value", async () => {
  const js = byName(await extract(`
function deep(a, b, c) {
  if (a) { for (const x of a) { while (x) { try { if (b) { go(); } } catch {} } } }
}
function chain(x) {
  if (x === 1) go(); else if (x === 2) go(); else if (x === 3) go(); else go();
}
function handler(req, res, next) { res.send(1); }
router.get("/", handler);
function direct(q, _unused) { return q; }
direct(1);
`, "javascript"));
  assert.equal(js.deep?.nesting, 5);
  assert.equal(js.chain?.nesting, 1, "an else-if chain is one level");
  assert.deepEqual(js.deep?.unusedParams, ["c"]);
  assert.deepEqual(js.handler?.unusedParams, ["req", "next"]);
  assert.equal(js.handler?.passedAsValue, true);
  assert.equal(js.direct?.passedAsValue, false);
  assert.deepEqual(js.direct?.unusedParams, ["_unused"]);

  const py = byName(await extract("def route(state):\n    return 'x'\n\ngraph.add_conditional_edges('a', route)\n", "python"));
  assert.deepEqual(py.route?.unusedParams, ["state"]);
  assert.equal(py.route?.passedAsValue, true);
});
