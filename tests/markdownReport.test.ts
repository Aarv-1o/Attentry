import assert from "node:assert/strict";
import { test } from "node:test";
import { codeSpan, collectFindings } from "../src/findings/collect.ts";
import { escapeMarkdown, formatMarkdown } from "../src/report/markdown.ts";
import { scanRepo } from "../src/scan/scan.ts";
import { makeRepo } from "./helpers.ts";

const TIME_AGO = `(date) {
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  return Math.floor(seconds / 3600) + "h ago";
}`;

test("--markdown: a summary table, then each part rule by rule, every place linked to its line", async () => {
  const root = await makeRepo({
    // Findings inside a file nothing uses are left out (the file is the finding): import it.
    "src/a.js": `import { s } from "../my app/key.js";\nexport function timeAgo${TIME_AGO}\n`,
    "src/b.js": `export function fileTimeAgo${TIME_AGO}\n`,
    "src/c.js": `export function again${TIME_AGO}\n`,
    "my app/key.js": `export const s = process.env.JWT_SECRET || "supersecret";\n`,
  });
  const md = formatMarkdown(await collectFindings(await scanRepo(root)), { root, showHints: false, stats: { files: 4, functions: 3 } });
  assert.match(md, /^# Attentry report: attentry-\w+\n\n4 files, 3 functions · \d+ findings/);
  assert.match(md, /\| Part \| Findings \| What it means \|\n\| --- \| ---: \| --- \|\n\| Security \| 1 \|/);
  // Security before clean-up; links work with spaces in the path.
  assert.ok(md.indexOf("## Security (1)") < md.indexOf("## Clean-up"));
  assert.match(md, /- \[`my app\/key\.js:1`\]\(my%20app\/key\.js#L1\): JWT\\_SECRET falls back/);
  assert.match(md, /### Exact copies · 1\n\n\*\*Why it matters:\*\* .+ {2}\n\*\*Safety:\*\* Ask first/);
  assert.match(md, / {2}- Also \[`src\/b\.js:1`\]\(src\/b\.js#L1\): copy: fileTimeAgo/);
  assert.match(md, /<details>\n<summary>How to fix it<\/summary>\n\n1\. /);
  assert.equal(formatMarkdown([], { root, showHints: false }).trimEnd().split("\n").at(-1), "**Nothing to fix.**");
});

test("text from code can't break the Markdown", () => {
  assert.equal(escapeMarkdown("any <script> in __html runs"), "any &lt;script&gt; in \\_\\_html runs");
  assert.equal(escapeMarkdown("`a || b` stays code, a | b doesn't"), "`a || b` stays code, a \\| b doesn't");
  assert.equal(escapeMarkdown("JSON.parse(`vo_${name}.js) cut off"), "JSON.parse(\\`vo\\_${name}.js) cut off");
  // A docstring quoting `fromisoformat` needs a longer fence to stay one code span.
  const span = codeSpan("`fromisoformat` handles `+00:00`");
  assert.equal(span, "`` `fromisoformat` handles `+00:00` ``");
  assert.equal(escapeMarkdown(`line 3: ${span} (only here)`), `line 3: ${span} (only here)`);
});
