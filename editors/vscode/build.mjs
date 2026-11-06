// Builds the extension: the extension itself, and the Claude Code plugin with Attentry built into it
// (one file, the tree-sitter grammars next to it). The language server runs that same file, so the
// editor and the agent always run one build, and the extension needs nothing else installed.
import { build } from "esbuild";
import { copyFile, cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAttentry } from "../../scripts/build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, "claude"); // a plugin marketplace with the one plugin in it

await rm(join(here, "dist"), { recursive: true, force: true }); // nothing left from an older build ships
await build({ entryPoints: [join(here, "src/extension.ts")], outfile: join(here, "dist/extension.js"), bundle: true, platform: "node", format: "cjs", target: "node20", external: ["vscode"] });
await rm(plugin, { recursive: true, force: true });
await cp(join(here, "../../claude-plugin"), plugin, { recursive: true });
await buildAttentry(join(plugin, "attentry/dist/attentry.mjs"));
// The plugin's version is the extension's: Claude Code reinstalls it when that changes.
const manifest = join(plugin, "attentry/.claude-plugin/plugin.json");
const { version } = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
await writeFile(manifest, `${JSON.stringify({ ...JSON.parse(await readFile(manifest, "utf8")), version }, null, 2)}\n`);
await copyFile(join(here, "../../LICENSE"), join(here, "LICENSE")); // the extension package needs its own copy
