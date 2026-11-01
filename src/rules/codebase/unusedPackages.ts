import { readdir, readFile, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import type { RepoIndex } from "../../index/repo.ts";
import { escapeRegex, readTexts } from "../../index/texts.ts";
import type { Confidence } from "../confidence.ts";

export interface UnusedPackage {
  name: string;
  manifest: string; // the package.json that declares it
  dev: boolean;
  confidence: Confidence;
  sizeBytes: number | undefined; // when installed
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
}

// Packages often show up only in configs: babel presets, eslint plugins, tsconfig "types", CSS @import.
const CONFIG_FILE = /\.(json|jsonc|ya?ml|toml|css|scss|sass|less|html)$|(^|\/)\.[\w.-]*rc(\.\w+)?$/;
const NOT_REFERENCES = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const BUILTINS = new Set(builtinModules);

const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined; // not installed, or not JSON: treated as unknown
  }
};

// "@scope/pkg/sub/path" -> "@scope/pkg", "lodash/fp" -> "lodash". Undefined for relative or built-in imports.
export function packageOf(source: string): string | undefined {
  if (/^[./]/.test(source) || source.startsWith("node:")) return undefined;
  const parts = source.split("/");
  const name = source.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  return BUILTINS.has(name) ? undefined : name;
}

// Sizes change only when a package is (re)installed, which rewrites its package.json: remembered
// until then, so re-checks after every edit don't walk node_modules again.
const sizes = new Map<string, { stamp: number; bytes: number }>();

async function packageSize(dir: string): Promise<number> {
  const stamp = (await stat(join(dir, "package.json"))).mtimeMs;
  const known = sizes.get(dir);
  if (known?.stamp === stamp) return known.bytes;
  const bytes = await folderSize(dir);
  sizes.set(dir, { stamp, bytes });
  return bytes;
}

async function folderSize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await folderSize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

// Command names a package installs: what `npm run` scripts actually call.
function binNames(name: string, installed: Manifest | undefined): string[] {
  const bin = installed?.bin;
  return bin && typeof bin === "object" ? Object.keys(bin) : [name.split("/").pop()!];
}

// Tools nothing imports: they find their own config file (or package.json key) and run from
// the editor, a pre-commit hook or the CLI. The file is the evidence that they're in use.
const TOOL_CONFIGS: [RegExp, RegExp, string?][] = [
  [/^prettier$|^prettier-plugin-|^@\w[\w-]*\/prettier-plugin/, /(^|\/)(\.prettierrc[\w.]*|prettier\.config\.\w+)$/, "prettier"],
  [/^eslint$|(^|\/)eslint-(config|plugin)(-|$)|^@typescript-eslint\/|^typescript-eslint$|^@eslint\//, /(^|\/)(\.eslintrc[\w.]*|eslint\.config\.\w+)$/, "eslintConfig"],
  [/^prisma$/, /(^|\/)schema\.prisma$/, "prisma"],
  [/^jest-environment-|^ts-jest$/, /(^|\/)jest\.(config|preset)\.\w+$/, "jest"],
  // Nx reads its .ts configs (jest.config.ts) with swc, and adds both packages for that.
  [/^@nx\/|^nx$|^@swc-node\/register$|^@swc\/(core|helpers)$/, /(^|\/)nx\.json$/],
  [/^stylelint/, /(^|\/)(\.stylelintrc[\w.]*|stylelint\.config\.\w+)$/, "stylelint"],
  [/^(husky|lint-staged)$/, /(^|\/)(\.husky\/|\.lintstagedrc)/, "lint-staged"],
];

// Peers frameworks need, for when node_modules isn't installed to say so: Remotion and Next
// render with react-dom although no file imports it.
const KNOWN_PEERS: [RegExp, RegExp][] = [
  [/^react-dom$/, /^(next|remotion|@remotion\/|gatsby|react-router-dom|@testing-library\/react|@react-three\/fiber)/],
  // React itself, under react-dom and every React framework (and JSX, which uses it unimported).
  [/^react$/, /^(react-dom|react-native|next|remotion|@remotion\/|gatsby|expo|react-router(-dom)?|@react-three\/fiber)$|^@remotion\//],
  [/^@swc\/core$/, /^(@swc-node\/|@swc\/jest$|unplugin-swc$)/],
  [/^tslib$/, /^typescript$/],
];

const mentions = (text: string, word: string) => new RegExp(`(^|[^\\w@/.-])${escapeRegex(word)}($|[^\\w-])`).test(text);

export async function findUnusedPackages(index: RepoIndex): Promise<UnusedPackage[]> {
  const unused: UnusedPackage[] = [];
  const manifests = index.allFiles.filter((f) => posix.basename(f) === "package.json");

  for (const manifestPath of manifests) {
    const dir = posix.dirname(manifestPath) === "." ? "" : `${posix.dirname(manifestPath)}/`;
    const manifest = await readJson<Manifest>(join(index.root, manifestPath));
    if (!manifest) continue;
    const inScope = (f: string) => f.startsWith(dir);

    const imported = new Set<string>();
    for (const [file, usage] of index.usage) {
      if (!inScope(file)) continue;
      for (const imp of usage.imports) {
        const pkg = packageOf(imp.source);
        if (pkg) imported.add(pkg);
      }
    }
    const textOf = async (files: string[]) => [...(await readTexts(index.root, files)).values()].join("\n");
    const configText = await textOf(index.allFiles.filter((f) => inScope(f) && CONFIG_FILE.test(f) && !NOT_REFERENCES.test(f)));
    // Names built at runtime, e.g. require.resolve(WASM_FILES[lang]), still appear as quoted strings.
    const sourceText = await textOf(index.files.filter(inScope));
    // Commands live outside "scripts" too: { "prisma": { "seed": "ts-node seed.ts" } }.
    const { dependencies: _d, devDependencies: _dd, peerDependencies: _p, ...commands } = manifest;
    const scripts = [...Object.values(manifest.scripts ?? {}), JSON.stringify(commands)].join("\n");

    const nodeModules = join(index.root, dir, "node_modules");
    const installed = new Map<string, Manifest | undefined>();
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const name of Object.keys(declared)) installed.set(name, await readJson<Manifest>(join(nodeModules, name, "package.json")));
    const quoted = (name: string) => new RegExp(`["'\`]${escapeRegex(name)}["'\`/]`).test(sourceText);

    // TypeScript is used by the editor and type checks (astro check, vite) wherever there's TS.
    const hasJsx = index.files.some((f) => inScope(f) && /\.(jsx|tsx)$/.test(f));
    const hasTypeScript = index.allFiles.some((f) => inScope(f) && /(^|\/)tsconfig[\w.-]*\.json$|\.(ts|tsx|mts|cts)$/.test(f));
    const configured = (name: string) => TOOL_CONFIGS.some(([pkg, file, key]) =>
      pkg.test(name) && (index.allFiles.some((f) => inScope(f) && file.test(f)) || (!!key && key in manifest)));
    const isUsed = (name: string): boolean => {
      if (name === "typescript" && hasTypeScript) return true;
      // JSX compiles to React calls with no import written (the automatic runtime).
      if (name === "react" && hasJsx) return true;
      if (configured(name)) return true;
      if (imported.has(name) || mentions(configText, name) || quoted(name)) return true;
      if (binNames(name, installed.get(name)).some((bin) => mentions(scripts, bin))) return true;
      if (name.startsWith("@types/")) {
        // @types/react follows react; @types/node and friends describe globals, so they stay.
        const typed = name.slice("@types/".length).replace(/^(.+)__(.+)$/, "@$1/$2");
        return !(typed in declared) || isUsed(typed);
      }
      return false;
    };

    const used = new Set(Object.keys(declared).filter(isUsed));
    // Something a used package needs as a peer is in use, even if never imported directly.
    const peerOfUsed = (name: string) => [...used].some((u) => installed.get(u)?.peerDependencies?.[name] !== undefined ||
      KNOWN_PEERS.some(([peer, needs]) => peer.test(name) && needs.test(u)));

    for (const [deps, dev] of [[manifest.dependencies, false], [manifest.devDependencies, true]] as const) {
      for (const name of Object.keys(deps ?? {})) {
        if (used.has(name)) continue;
        if (peerOfUsed(name)) continue;
        const pkg = installed.get(name);
        // Without node_modules we can't check peers, so we're less sure.
        const confidence: Confidence = dev || !pkg ? "likely" : "sure";
        const sizeBytes = pkg ? await packageSize(join(nodeModules, name)).catch(() => undefined) : undefined;
        unused.push({ name, manifest: manifestPath, dev, confidence, sizeBytes });
      }
    }
  }
  return unused;
}
