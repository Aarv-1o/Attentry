import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildIndex } from "../src/index/repo.ts";
import { formatDuplicates } from "../src/report/duplicates.ts";
import { findDifferences, normalizeLine } from "../src/rules/codebase/differences.ts";
import { findDuplicates } from "../src/rules/codebase/duplicates.ts";
import { makeRepo } from "./helpers.ts";

const flagRepo = fileURLToPath(new URL("fixtures/duplicates/flag", import.meta.url));

test("normalizeLine: names don't matter, values do", () => {
  assert.equal(normalizeLine("if (mins < 1) return 'Just now';"), normalizeLine('if (m < 1) return "Just now";'));
  assert.notEqual(normalizeLine('if (s < 45) return "just now";'), normalizeLine('if (mins < 1) return "Just now";'));
  assert.equal(normalizeLine("return `${mins}m ago`;"), normalizeLine("return `${m}m ago`;"));
});

test("drifted copy: shows the lines that changed, against the most common version", async () => {
  const groups = findDuplicates((await buildIndex(flagRepo)).functions);
  const drifted = groups.find((g) => g.kind === "similar")!;
  const diff = await findDifferences(flagRepo, drifted);
  assert.ok(diff);
  assert.notEqual(diff.base.name, "relativeTime", "the base is a version that has a twin");
  assert.deepEqual(diff.copies.map((c) => c.fn.name), ["relativeTime"]);
  const changed = diff.copies[0]!.changes.map((c) => [c.base?.text.trim(), c.copy?.text.trim()]);
  assert.ok(changed.some(([b, c]) => b?.includes("Just now") && c?.includes('"just now"')));
  assert.ok(changed.some(([b, c]) => b?.includes("m ago") && c?.includes(" min ago")));
});

test("exact copies and cross-language copies aren't compared line by line", async () => {
  const groups = findDuplicates((await buildIndex(flagRepo)).functions);
  for (const g of groups.filter((g) => g.kind !== "similar")) assert.equal(await findDifferences(flagRepo, g), undefined);
});

test("report shows what differs, value changes first", async () => {
  const groups = findDuplicates((await buildIndex(flagRepo)).functions);
  const differences = new Map();
  for (const g of groups) {
    const d = await findDifferences(flagRepo, g);
    if (d) differences.set(g, d);
  }
  const text = formatDuplicates(groups, false, differences);
  assert.match(text, /What differs from web\/(time\.ts:1 timeAgo|Page\.tsx:2 fileTimeAgo):/);
  assert.match(text, /web\/chat\.js:2 relativeTime\n +\d+: if \(mins < 1\) return "just now";\n +instead of: if \(\w+ < 1\) return ['"]Just now['"];/);
  assert.match(text, /Identical apart from names\./);
});

test("reformatting isn't a difference; functions that differ in most lines are flagged as such", async () => {
  const root = await makeRepo({
    "a.js": `export function send(msg) {
  if (!msg) return;
  const res = fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: msg });
  if (!res.ok) throw new Error("HTTP error! status: " + res.status);
  return res;
}
`,
    "b.js": `export function post(text) {
  if (!text) return;
  const res = fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: text,
  });
  if (!res.ok) throw new Error("HTTP error! status: " + res.status);
  return res;
}
`,
  });
  const groups = findDuplicates((await buildIndex(root)).functions);
  const similar = groups.find((g) => g.kind === "similar");
  if (similar) {
    const diff = await findDifferences(root, similar);
    assert.equal(diff, undefined, "only the layout differs");
  }
});

test("docstrings and comments aren't differences: only the code that runs is compared", async () => {
  const parse = (doc: string, arg: string) => `from datetime import datetime, timezone

def parsed(stamp):${doc}
    if not stamp:
        return None
    try:
        d = datetime.fromisoformat(${arg}.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
`;
  const doc = `
    """A PostgREST timestamp as an aware datetime.

    \`fromisoformat\` handles \`+00:00\`, not a trailing \`Z\`.
    """`;
  const root = await makeRepo({
    "a.py": parse("", "str(stamp)"),
    "b.py": parse("", "str(stamp)").replace("def parsed", "def ts"),
    "c.py": parse(doc, "stamp"),
  });
  const groups = findDuplicates((await buildIndex(root)).functions);
  const drifted = groups.find((g) => g.kind === "similar")!;
  const diff = await findDifferences(root, drifted);
  assert.deepEqual(diff?.copies[0]!.changes.map((c) => [c.base?.line, c.copy?.line]), [[7, 11]], "only the line that runs differently");
  // A copy that only gained a docstring is still an exact copy.
  const withDoc = await makeRepo({ "a.py": parse("", "stamp"), "b.py": parse(doc, "stamp") });
  assert.equal(findDuplicates((await buildIndex(withDoc)).functions)[0]?.kind, "exact");
});
