// Builds the extension: the extension itself, and the Claude Code and Codex plugins with Attentry built into them
// (one file, the tree-sitter grammars next to it). The language server runs that same file, so the
// editor and the agent always run one build, and the extension needs nothing else installed.
import { Resvg } from "@resvg/resvg-js";
import { build } from "esbuild";
import { copyFile, cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAttentry } from "../../scripts/build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const claude = join(here, "claude"); // a plugin marketplace with the one plugin in it
const codex = join(here, "codex"); // the same for Codex: its own manifest and hooks, the same Attentry
const { version } = JSON.parse(await readFile(join(here, "package.json"), "utf8"));

// Copies an agent's plugin marketplace from the repo, and stamps the plugin with the extension's
// version: the agent reinstalls the plugin when that changes.
async function plugin(source, out, manifest) {
  await rm(out, { recursive: true, force: true });
  await cp(join(here, "../..", source), out, { recursive: true });
  const file = join(out, "attentry", manifest);
  await writeFile(file, `${JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), version }, null, 2)}\n`);
}

await rm(join(here, "dist"), { recursive: true, force: true }); // nothing left from an older build ships
await build({ entryPoints: [join(here, "src/extension.ts")], outfile: join(here, "dist/extension.js"), bundle: true, platform: "node", format: "cjs", target: "node20", external: ["vscode"] });
await plugin("claude-plugin", claude, ".claude-plugin/plugin.json");
await buildAttentry(join(claude, "attentry/dist/attentry.mjs"));
// Codex gets a copy of that build and of the skills: each agent copies its plugin into its own
// cache, so the two can't share one folder.
await plugin("codex-plugin", codex, ".codex-plugin/plugin.json");
for (const part of ["dist", "skills"]) await cp(join(claude, "attentry", part), join(codex, "attentry", part), { recursive: true });
await copyFile(join(here, "../../LICENSE"), join(here, "LICENSE")); // the extension package needs its own copy
// The Marketplace wants a PNG icon: drawn from the brand's app tile, so the two never differ.
const tile = await readFile(join(here, "../../brand/attentry-tile.svg"), "utf8");
await writeFile(join(here, "dist/icon.png"), new Resvg(tile, { fitTo: { mode: "width", value: 128 } }).render().asPng());
