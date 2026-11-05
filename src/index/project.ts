import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSource } from "./files.ts";

// The project in a folder. Agents and editors are often opened one folder too high (the
// Downloads folder a repo was unzipped into, a folder of several checkouts), and a scan of that
// can't tell what changed. When the folder isn't a project itself but holds exactly one, that
// one is the project.

const MANIFEST = /^(package\.json|pyproject\.toml|requirements\.txt|setup\.py|manage\.py)$/;
const isGit = (dir: string) => existsSync(join(dir, ".git"));

// A folder as the file system spells it, for naming things after a repo: on Windows d:\repo and
// D:\REPO are one folder (VS Code says d:, a terminal D:), and links lead to their target.
export const folderId = (folder: string) => realpathSync.native(folder);

export async function projectRoot(folder: string): Promise<string> {
  if (isGit(folder)) return folder;
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return folder; // unreadable: let the scan say so
  }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => join(folder, e.name));
  const checkouts = dirs.filter(isGit);
  if (checkouts.length === 1) return checkouts[0]!;
  // Nothing here but one folder that is a project of its own: an unzipped repo. (A folder
  // holding only src/ is a project whose code is in src/: not this case.)
  const ownCode = entries.some((e) => e.isFile() && (MANIFEST.test(e.name) || isSource(e.name)));
  if (!ownCode && dirs.length === 1 && (await looksLikeProject(dirs[0]!))) return dirs[0]!;
  return folder;
}

// The git repo a folder is in (a subfolder of it, or the repo itself), else the project in the folder.
export async function repoAround(folder: string): Promise<string> {
  for (let dir = folder; ; dir = dirname(dir)) {
    if (isGit(dir)) return dir;
    if (dirname(dir) === dir) return projectRoot(folder);
  }
}

async function looksLikeProject(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((name) => MANIFEST.test(name) || /^(\.git|\.gitignore|readme(\.\w+)?)$/i.test(name));
  } catch {
    return false; // unreadable: not one to pick
  }
}
