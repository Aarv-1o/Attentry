# Detron

Detron stops AI coding agents from making a mess of your codebase.

It watches what your agent writes, catches duplicate code, dead code and bloat,
gets the agent to clean it up, proves nothing broke, and explains what changed.

> Status: early build. Not on npm yet. Works today: copied code, dead code, frontend/backend
> mismatches, security, crash risks, database checks, code hygiene and hotspots, in the
> terminal and in your editor.

## Try it

Needs Node 22+. From a clone of this repo:

```
npm install
npm run detron -- scan path/to/your/repo
```

- `--changed` shows only what your changes added: this branch since it left main, or your
  uncommitted work on main. Grouped as Security, Will break, Database, Clean-up, with the code
  explained in plain words
- `--brief` prints one line per error or warning, at most 10: what an agent should get (a few
  hundred tokens, not thousands)
- `--all` also shows hints (less certain findings)
- `--agent` prints findings as steps an AI agent can follow: what, why, how to fix, whether
  it's safe to do alone, and how to check
- `--markdown` writes a report to read in a Markdown preview (VS Code, GitHub, a PR comment):
  a summary table, then every finding linked to its line, with the fix folded under it.
  `--out detron-report.md` saves it to a file (as UTF-8, even from PowerShell)
- `--json` prints the same findings, machine-readable
- `detron explain src/app.ts:42` gives everything about the findings on one line

To silence one finding, write why: `// detron-ignore empty-catch: the cache is optional`
(`#` in Python) on its line or the line above. Without a reason, it doesn't count.

## With your agent

```
npm run build                      # once: Detron as one file, dist/detron.mjs
node dist/detron.mjs init path/to/your/repo
```

That sets up Claude Code's hooks in your repo (`.claude/settings.local.json`; Cursor and
Copilot CLI read them too). Then, in every agent session:

- **Before it writes a function the repo already has**, the agent hears where the existing one is
  ("`timeAgo` in utils/time.js:1, used in 9 places, has the same code: import it"), so it reuses
  instead of adding a copy
- **After each edit** the agent hears only problems this task added, once each, in a few lines,
  and nothing when the edit is clean. Old issues in the repo never nag
- **Every 10 edits** a check-in: what to focus on
- **At the end** a one-line summary for you
- **Suggest mode** (default) only tells the agent. `init --mode block` also refuses exact copies,
  sends new security or crash problems back as errors, and won't let the task finish while
  they're there

A background Detron keeps the repo in memory (never on disk), so a check after an edit takes
about a tenth of a second. It starts on first use and stops after a quiet half hour.

## In your editor

`editors/vscode` is an extension for VS Code, Cursor, Windsurf and Antigravity. Build it with
`npm install && npm run package` in that folder, then install the `.vsix` (Extensions →
"..." → Install from VSIX). Other editors (JetBrains, Zed, Neovim) can run `detron lsp` as a
language server.

- Squiggles on **your changes** by default; click the status bar for the whole repo
- Hover a squiggle: what the code does in plain words, what can go wrong, how to fix and check.
  Built from the code itself, so it costs no AI credits
- Security and crash risks are errors, things that will break are warnings, clean-up is info
  (faded for unused code). Editors' agents read errors and warnings, so they see real problems
  while they work, and nothing is spent on clean-up
- Light bulb: delete unused code (the only automatic fix), copy the fix for your agent, ignore
  with a reason, or "not useful" (a rule marked on more than 10% of its findings becomes a hint)
- A line at the top of hotspot files: make small changes there, and test after each

It finds:

- **Copies:** exact and drifted copies of functions (with what differs), including the same logic in JS and Python
- **Dead code:** unused packages (with sizes), unused files, functions nothing calls
- **Frontend and backend:** calls to API routes that don't exist (and the route it likely meant),
  calls with the wrong method, routes nothing calls. Backends: Express, Koa, Hono, Fastify,
  NestJS, Next.js, FastAPI, Flask, Django/DRF. Frontends: fetch, axios (with base URLs),
  apisauce (React Native), superagent, generated clients, Vite's proxy
- **Security, endpoint by endpoint:** routes with no auth, admin routes without a role check,
  records loaded by id with no owner check (IDOR), login with no rate limit. In the code: SQL /
  NoSQL / command injection, eval, SSRF, open redirects, file paths, mass assignment, hardcoded
  and leaked secrets, `.env` in the repo, XSS, CORS with credentials, leaked stack traces, weak
  password storage, unverified JWTs, `Math.random()` tokens
- **Crash risks:** async Express 4 handlers with no try/catch, `JSON.parse` on outside data,
  exiting the process in a handler
- **Database:** money stored as floats, queries inside loops (N+1), trees walked one query
  per level, INSERT without columns; hints for SELECT *, ORDER BY RAND() and `LIKE '%x%'`
  search. Mongoose, Sequelize, TypeORM, Prisma, Knex, Django, SQLAlchemy, SQLModel, raw SQL
- **Hotspots:** complex files that change often (from git history), so you know where to
  clean first. Needs a git clone, not a downloaded zip
- **Code hygiene:** errors that are ignored or only logged, commented-out code, comments that
  repeat the code, unused parameters, deep nesting

Supports JavaScript, TypeScript (incl. JSX/TSX), Python and Astro.

- What V1 will do: [SPEC.md](SPEC.md)
- Rules for anyone (human or agent) working on this repo: [AGENTS.md](AGENTS.md)
- Research behind the decisions: [docs/research.md](docs/research.md)
