import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test, and every Attentry it starts, gets a home folder of its own: connecting an agent,
// running a hook or starting the background Attentry writes to ~/.attentry, and a test must never
// change the person's own. Node finds the home folder in HOME, and on Windows in USERPROFILE.
const home = mkdtempSync(join(tmpdir(), "attentry-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
