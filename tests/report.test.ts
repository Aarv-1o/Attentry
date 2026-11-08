import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeFunction } from "./helpers.ts";
import { formatDuplicates } from "../src/report/duplicates.ts";
import type { DuplicateGroup } from "../src/rules/codebase/duplicates.ts";

const fn = (name: string, file: string, startLine: number) => fakeFunction({ name, file, startLine });

const groups: DuplicateGroup[] = [
  { kind: "exact", confidence: "sure", sharedValues: ["just now", "m ago"], functions: [fn("timeAgo", "a.ts", 3), fn("fileTimeAgo", "b.ts", 8)] },
  { kind: "similar", confidence: "maybe", sharedValues: [], functions: [fn("fetchClients", "c.ts", 1), fn("fetchItems", "d.ts", 1)] },
];

test("text report: sure copies with locations, evidence and advice; hints hidden by default", () => {
  const text = formatDuplicates(groups, false);
  assert.match(text, /Copies \(1\)/);
  assert.match(text, /1\. timeAgo, fileTimeAgo \(2 copies\)/);
  assert.match(text, /a\.ts:3 {2}timeAgo/);
  assert.match(text, /Same wording: "just now", "m ago"/);
  assert.match(text, /→ Keep one, import it everywhere else\./);
  assert.match(text, /1 more hint hidden/);
  assert.doesNotMatch(text, /fetchClients/);
});

test("text report: a copy in a browser app and its server can't be imported across: say what to do instead", () => {
  const apart: DuplicateGroup = { kind: "exact", confidence: "sure", sharedValues: [], functions: [fn("haversineKm", "client/src/DriverApp.jsx", 10), fn("haversineKm", "server/index.js", 24)] };
  const app = (file: string) => (file.startsWith("client/") ? "client/" : "server/");
  assert.match(formatDuplicates([apart], false, new Map(), new Set(), app), /→ They're in different apps \(client, server\), which can't import from each other: move it to a package they share/);
  assert.match(formatDuplicates([apart], false), /→ Keep one, import it everywhere else\./, "one app: import it");
});

test("text report: --all shows hints", () => {
  assert.match(formatDuplicates(groups, true), /Hints \(1\)[\s\S]*fetchClients/);
});

test("text report: copies in unused files are marked; only-hints says so", () => {
  const text = formatDuplicates([groups[0]!], false, new Map(), new Set(["b.ts"]));
  assert.match(text, /b\.ts:8 {2}fileTimeAgo {2}\(in a file that looks unused\)/);
  assert.equal(formatDuplicates([groups[1]!], false), "No copies found (1 more hint hidden. Run with --all to see them).\n");
});

test("text report: says so when there is nothing", () => {
  assert.equal(formatDuplicates([], false), "No copies found.\n");
});
