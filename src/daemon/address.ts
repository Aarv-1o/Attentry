import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { folderId } from "../index/project.ts";

// Where one repo's background Detron listens: a named pipe on Windows, a socket in a folder
// only this user can open elsewhere. Named after the repo, so each repo gets its own.

export function addressFor(root: string): string {
  const id = createHash("sha256").update(folderId(root)).digest("hex").slice(0, 16);
  const user = userInfo().username.replace(/[^\w.-]/g, "_");
  if (process.platform === "win32") return `\\\\.\\pipe\\detron-${user}-${id}`;
  // Socket paths have a short length limit (about 100 characters on macOS): stay short.
  const base = tmpdir().length > 40 ? "/tmp" : tmpdir();
  const dir = join(base, `detron-${user}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // /tmp is shared: a folder someone else made first, or left open, isn't ours to trust.
  const folder = lstatSync(dir);
  if (!folder.isDirectory() || folder.uid !== process.getuid!() || (folder.mode & 0o077) !== 0) {
    throw new Error(`${dir} isn't a private folder of yours: delete it, and Detron makes it again`);
  }
  return join(dir, `${id}.sock`);
}

// Which Detron is running: a background Detron from before an update must not answer.
export function buildId(): string {
  const entry = process.argv[1] ?? "";
  return `${entry}:${statSync(entry, { throwIfNoEntry: false })?.mtimeMs ?? 0}`;
}

// A pipe or socket name can be taken by any process that gets there first, and whatever answers
// there talks straight to the agent. So each request carries a random challenge that only a
// Detron holding this person's key (in their home folder, unreadable to others) can sign.
let kept: Buffer | undefined;
function key(): Buffer {
  if (kept) return kept;
  const dir = join(homedir(), ".detron");
  const path = join(dir, "daemon.key");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }); // the first one makes it
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return (kept = readFileSync(path));
}

export const challenge = () => randomBytes(16).toString("hex");
export const sign = (nonce: string) => createHmac("sha256", key()).update(nonce).digest("hex");
export const signedBy = (nonce: string, seal: unknown) =>
  typeof seal === "string" && seal.length === 64 && timingSafeEqual(Buffer.from(seal), Buffer.from(sign(nonce)));
