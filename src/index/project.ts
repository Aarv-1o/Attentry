import { existsSync, realpathSync, type Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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

// The project the person chose for a folder of several (the editor panel's menu), in
// ~/.attentry/projects.json: one file every Attentry reads, so the editor, the agents' hooks and
// their tools all check the same one.
const choicesFile = () => join(homedir(), ".attentry", "projects.json");
async function readChoices(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(choicesFile(), "utf8")) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; // nothing chosen anywhere yet
    throw error;
  }
}

// `project`: a folder inside `folder`, or `folder` itself for all of it; undefined forgets the choice.
export async function chooseProject(folder: string, project: string | undefined): Promise<void> {
  const { [folderId(folder)]: _old, ...choices } = await readChoices();
  await mkdir(dirname(choicesFile()), { recursive: true });
  await writeFile(choicesFile(), `${JSON.stringify(project === undefined ? choices : { ...choices, [folderId(folder)]: project }, null, 2)}\n`);
}

const subfolders = (folder: string, entries: Dirent[]) =>
  entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => join(folder, e.name));

// The projects one level down: git checkouts, and folders that look like a project.
export async function projectsIn(folder: string): Promise<string[]> {
  const dirs = subfolders(folder, await readdir(folder, { withFileTypes: true }).catch(() => []));
  const found = await Promise.all(dirs.map(async (dir) => isGit(dir) || (await looksLikeProject(dir))));
  return dirs.filter((_, i) => found[i]);
}

export async function projectRoot(folder: string): Promise<string> {
  if (isGit(folder)) return folder;
  const chosen = existsSync(folder) ? (await readChoices())[folderId(folder)] : undefined;
  if (chosen && existsSync(chosen)) return chosen; // a chosen project that's since been deleted: picked again
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return folder; // unreadable: let the scan say so
  }
  const dirs = subfolders(folder, entries);
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
