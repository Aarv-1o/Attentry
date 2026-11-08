import type { FunctionFacts } from "../index/facts.ts";
import { isGenerated, unsupportedCode } from "../index/files.ts";
import { buildIndex, type RepoIndex } from "../index/repo.ts";
import type { DeadCode } from "../report/deadCode.ts";
import { findDeadFunctions } from "../rules/codebase/deadFunctions.ts";
import { findDifferences, type CopyDifferences } from "../rules/codebase/differences.ts";
import { findDuplicates, type DuplicateGroup } from "../rules/codebase/duplicates.ts";
import { findFunctionShapeIssues } from "../rules/codebase/functionShape.ts";
import { findHotspots, gitHistory, type FileSize, type History, type Hotspot } from "../rules/codebase/hotspots.ts";
import { findUnusedFiles } from "../rules/codebase/unusedFiles.ts";
import { findUnusedPackages } from "../rules/codebase/unusedPackages.ts";
import { findCrossStack, type CrossStack } from "../rules/crossStack/check.ts";
import { htmlCallsIn } from "../rules/crossStack/htmlCalls.ts";
import type { FileApi } from "../rules/crossStack/types.ts";
import { uncheckedDoors, type UncheckedDoors } from "../rules/security/unchecked.ts";
import { DATABASE_RULES, moneyInSchemaText, usesDatabase } from "../rules/database/index.ts";
import { findEndpointIssues } from "../rules/security/endpoints.ts";
import { committedEnvFiles, CRASH_RULES, SECURITY_RULES } from "../rules/security/index.ts";
import type { LineFinding } from "../rules/line/index.ts";
import type { FileCache } from "../index/fileScan.ts";
import { readTexts } from "../index/texts.ts";
import { ignoreChecker } from "../findings/ignores.ts";

// Every check on one repo, with no printing: the CLI, and later the MCP server and the editor
// extension, all start from this.

export interface ScanResult {
  root: string;
  index: RepoIndex;
  facts: FunctionFacts[]; // what each function does, for plain-language explanations
  skipped: Map<string, number>; // files in languages Attentry doesn't read yet, by extension
  groups: DuplicateGroup[];
  differences: Map<DuplicateGroup, CopyDifferences>;
  dead: DeadCode;
  deadFiles: Set<string>;
  crossStack: CrossStack;
  hygiene: LineFinding[]; // without findings in dead files: the fix there is deleting the file
  database: LineFinding[]; // these three include dead files: a new file is dead until it's wired in
  security: LineFinding[];
  unchecked: UncheckedDoors[]; // doors to the outside the security checks don't read yet
  crashes: LineFinding[];
  hasDatabase: boolean; // a database library or schema file was found
  history: History;
  hotspots: Hotspot[];
  seconds: number;
}

const RATE_LIMIT_LIBRARY = /^(express-rate-limit|express-slow-down|rate-limiter-flexible|@fastify\/rate-limit|hono-rate-limiter|@upstash\/ratelimit|@nestjs\/throttler|koa-ratelimit|slowapi|flask_limiter|django_ratelimit|ratelimit|fastapi_limiter)/;

// `cache` keeps what each file taught us between scans (the editor and agent hooks reuse one),
// so only changed files are read again. Without one, every file is read.
export async function scanRepo(root: string, cache: FileCache = new Map()): Promise<ScanResult> {
  const started = Date.now();
  const index = await buildIndex(root, cache);
  const scans = [...index.scans];
  const lineFindings: LineFinding[] = scans.flatMap(([, s]) => s.lines);
  const apis = new Map<string, FileApi>(scans.map(([file, s]) => [file, s.api]));
  const sizes = new Map<string, FileSize>(scans.map(([file, s]) => [file, s.size]));
  const facts: FunctionFacts[] = scans.flatMap(([, s]) => s.facts);
  lineFindings.push(...findFunctionShapeIssues(index.functions));

  const groups = findDuplicates(index.functions);
  const differences = new Map<DuplicateGroup, CopyDifferences>();
  for (const group of groups) {
    const diff = await findDifferences(root, group);
    if (!diff) continue;
    differences.set(group, diff);
    // Similar structure and shared wording, but most lines differ: a hint, not a copy.
    if (diff.mostlyDifferent) group.confidence = "maybe";
  }

  const dead: DeadCode = {
    packages: await findUnusedPackages(index),
    files: await findUnusedFiles(index),
    functions: await findDeadFunctions(index),
  };
  // Clean-up inside a file that's dead as a whole is noise: the fix is deleting the file. Security,
  // crash and database problems still count: a file an agent just wrote is unused until it's wired in.
  const deadFiles = new Set(dead.files.map((f) => f.file));
  for (const file of deadFiles) {
    apis.delete(file);
    sizes.delete(file);
  }

  // Prisma schemas and SQL files aren't parsed: their columns are read as text.
  const schemas = await readTexts(root, index.allFiles.filter((f) => /\.(prisma|sql)$/i.test(f)));
  for (const [file, text] of schemas) lineFindings.push(...moneyInSchemaText(file, text));
  const live = lineFindings.filter((f) => !deadFiles.has(f.file));
  const serious = (rules: Set<string>) => lineFindings.filter((f) => rules.has(f.rule));

  const imports = new Map([...index.usage].map(([file, u]) => [file, u.imports]));
  const crossStack = findCrossStack(apis, imports, await htmlCallsIn(root, index.allFiles));
  // Rate limiting may be set up in ways we can't trace (a gateway, a global limiter): if a
  // library is there, a route without one is only a hint.
  const rateLimitLibrary = [...imports.values()].some((list) => list.some((i) => RATE_LIMIT_LIBRARY.test(i.source)));
  const texts = await readTexts(root, index.files);
  const endpointIssues = findEndpointIssues({ routes: crossStack.allRoutes, functions: index.functions, texts, rateLimitLibrary, allFiles: index.allFiles });
  // Findings that depend on the whole repo: Express 5 (or express-async-errors) catches async
  // errors; a hashing library anywhere means passwords may be hashed in a model hook.
  const manifest = await readTexts(root, index.allFiles.filter((f) => /(^|\/)package\.json$/.test(f)));
  const deps = [...manifest.values()].join("\n");
  // Only Express 4 leaves async errors uncaught: Koa, Hono, Fastify, Nest and Express 5 catch them.
  const express4 = /"express"\s*:\s*"[\^~>=]*4/.test(deps) && !/"express-async-errors"|"express-async-handler"|"express-promise-router"/.test(deps);
  const hashes = [...imports.values()].some((list) => list.some((i) => /^(bcrypt|bcryptjs|argon2|@node-rs\/(argon2|bcrypt)|passlib|werkzeug\.security|django\.contrib\.auth)/.test(i.source)));
  // `// attentry-ignore rule: reason` comments, so every report leaves out the same findings.
  const ignored = ignoreChecker(texts);
  const notIgnored = (file: string, line: number, rule: string) => !ignored(file, line, rule)?.reason;
  dead.functions = dead.functions.filter((d) => notIgnored(d.fn.file, d.fn.startLine, "dead-function"));
  crossStack.missing = crossStack.missing.filter((m) => notIgnored(m.file, m.line, m.kind));
  const keep = (f: LineFinding) => notIgnored(f.file, f.line, f.rule) && !(f.rule === "async-handler-no-catch" && !express4) && !(f.rule === "plaintext-password" && hashes);
  const history = await gitHistory(root);
  return {
    root, index, facts, skipped: unsupportedCode(index.allFiles), groups, differences, dead, deadFiles, crossStack,
    // Generated code (an API client) isn't tidied by hand: only its security and crash problems count.
    hygiene: live.filter((f) => !isGenerated(f.file) && !DATABASE_RULES.has(f.rule) && !SECURITY_RULES.has(f.rule) && !CRASH_RULES.has(f.rule) && keep(f)),
    database: serious(DATABASE_RULES).filter(keep),
    hasDatabase: usesDatabase(imports.values(), index.allFiles),
    security: [...endpointIssues, ...committedEnvFiles(index.allFiles), ...serious(SECURITY_RULES)].filter(keep),
    unchecked: uncheckedDoors(index.usage),
    crashes: serious(CRASH_RULES).filter(keep),
    history, hotspots: history.ok ? findHotspots(history.changes, sizes, history.commits) : [],
    seconds: (Date.now() - started) / 1000,
  };
}
