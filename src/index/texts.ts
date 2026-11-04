import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp[34]|wav|pdf|zip|gz|pem|lock)$|package-lock\.json$/i;
const AT_ONCE = 64; // files read in parallel: fast, without running out of file handles

// The background Detron rescans after every edit, and most files haven't changed since the last
// scan: their text is kept, and read again only when their size or modified time changes.
const known = new Map<string, { stamp: string; text: string }>();

// "size:mtime": changes whenever the file does. Undefined when it's gone.
export async function stampOf(path: string): Promise<string | undefined> {
  try {
    const s = await stat(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return undefined; // deleted since the file list was made
  }
}

async function textOf(path: string): Promise<string> {
  const stamp = await stampOf(path);
  if (!stamp) return "";
  const kept = known.get(path);
  if (kept?.stamp === stamp) return kept.text;
  const text = await readFile(path, "utf8").catch(() => "");
  known.set(path, { stamp, text });
  return text;
}

// Runs `each` on every item, AT_ONCE at a time, keeping the order of the results.
export async function inBatches<T, R>(items: T[], each: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += AT_ONCE) results.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(each))));
  return results;
}

// Text of the given repo files, skipping binaries. Unreadable files come back empty.
export async function readTexts(root: string, files: string[]): Promise<Map<string, string>> {
  const wanted = files.filter((file) => !BINARY.test(file));
  const texts = await inBatches(wanted, (file) => textOf(join(root, file)));
  return new Map(wanted.map((file, i) => [file, texts[i]!]));
}

export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
