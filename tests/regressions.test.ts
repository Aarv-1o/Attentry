import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectFindings } from "../src/findings/collect.ts";
import { scanRepo } from "../src/scan/scan.ts";

// Repos made from hand-checked reviews of real AI-built code. Each lists every finding Detron
// must report there, hints included: a new finding is a false alarm until a person says it
// isn't, and a missing one is a real problem Detron stopped catching.

const DIR = join(import.meta.dirname, "fixtures/regressions");

for (const name of readdirSync(join(DIR, "repos"))) {
  test(`regression repo ${name}: exactly the findings a person checked`, async () => {
    const root = join(DIR, "repos", name);
    const expected = JSON.parse(readFileSync(join(DIR, `${name}.expected.json`), "utf8")) as { found: Record<string, string> };
    const actual = (await collectFindings(await scanRepo(root))).map((f) => `${f.rule} ${f.file}:${f.line} ${f.confidence}`);
    const unexpected = actual.filter((f) => !(f in expected.found));
    const missing = Object.keys(expected.found).filter((f) => !actual.includes(f));
    assert.deepEqual(
      { unexpected, missing },
      { unexpected: [], missing: [] },
      "unexpected: new findings (false alarms, or check them and add them to the .expected.json); missing: real problems no longer found",
    );
  });
}
