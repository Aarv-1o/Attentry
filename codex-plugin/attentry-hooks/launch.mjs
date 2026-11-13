// Codex runs this for each of Attentry's hooks. Codex asks the person to trust a plugin's hooks
// again whenever any file in the plugin changes, so this plugin never changes: it runs the
// Attentry that the editor extension names in ~/.attentry/build.json, which moves with updates.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pointer = join(homedir(), ".attentry", "build.json");
const entry = existsSync(pointer) ? JSON.parse(readFileSync(pointer, "utf8")).entry : undefined;
if (!entry || !existsSync(entry)) {
  process.stderr.write(`Attentry: open your editor with the Attentry extension once, so Codex can find Attentry (${pointer}).\n`);
  process.exit(1);
}
process.argv = [process.argv[0], entry, ...process.argv.slice(2)];
await import(pathToFileURL(entry).href);
