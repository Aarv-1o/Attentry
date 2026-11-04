import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// git's output for a command run in `root`. windowsHide: the background Detron has no console, and
// without it Windows opens one for every git call (0.4s each, several per scan).
export const git = async (root: string, args: string[]) => (await run("git", ["-C", root, ...args], { maxBuffer: 256 * 1024 * 1024, windowsHide: true })).stdout;
