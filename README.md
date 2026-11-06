# Attentry

Attentry stops AI coding agents from making a mess of your codebase.

It watches what your agent writes, catches duplicate code, dead code and bloat,
gets the agent to clean it up, proves nothing broke, and explains what changed.

> Status: early build. Not on npm yet. Works today: copied code, dead code, frontend/backend
> mismatches, security, crash risks, database checks, code hygiene and hotspots, in the
> terminal and in your editor.

## Try it

Needs Node 22+. From a clone of this repo:

```
npm install
npm run attentry -- scan path/to/your/repo
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
  `--out attentry-report.md` saves it to a file (as UTF-8, even from PowerShell)
- `--json` prints the same findings, machine-readable
- `attentry explain src/app.ts:42` gives everything about the findings on one line
- `attentry doctor` says whether Attentry is set up and working here: which folder it checks, git,
  whether Claude Code is connected, and what to do about anything missing

To silence one finding, write why: `// attentry-ignore empty-catch: the cache is optional`
(`#` in Python) on its line or the line above. Without a reason, it doesn't count.

## With Claude Code

The easy way: install the VS Code extension (below) and click **Connect Claude Code** in the
Attentry panel. That installs Attentry's Claude Code plugin for every project: the hooks, the MCP
tools, and `/attentry:check` and `/attentry:explain`. When the extension updates, so does the plugin.

From a clone of this repo instead:

```
npm run build                      # once: Attentry as one file, dist/attentry.mjs
node dist/attentry.mjs init path/to/your/repo
```

That sets up Claude Code's hooks in that repo (`.claude/settings.local.json`). Then, in every
Claude Code session:

- **Before it writes a function the repo already has**, the agent hears where the existing one is
  ("`timeAgo` in utils/time.js:1, used in 9 places, has the same code: import it"), so it reuses
  instead of adding a copy
- **After each edit** the agent hears only problems this task added, once each, in a few lines,
  and nothing when the edit is clean. Old issues in the repo never nag
- **At the start** one line, so the agent knows Attentry is on for this project
- **Before it starts on a plan** (Claude Code's plan mode), notes on what the repo already has:
  a helper the plan would write again ("`formatTimeAgo`: the repo already has `timeAgo`"), a
  route that's already there, files that change all the time, a plan too big for one go. Only
  matches it's sure of, never a block, and nothing when there's nothing to say
- **Every 10 edits** a check-in: what to focus on
- **Tests** run at each check-in, in the background (the agent doesn't wait), and again at the
  end. If they fail, the agent hears it on its next edit. Attentry finds the command (`npm test`,
  `pnpm test`, pytest, in each app of the repo), or set `"tests": "make check"` (or `"off"`) in
  `.attentry/config.json`; `"testTimeoutSeconds"` limits a run (default 300, then the whole process
  tree is stopped). A repo's test command runs whatever the repo says, so Attentry runs only the
  commands you allowed by connecting it (`init`, or Connect in the sidebar), and asks again when
  they change. `attentry doctor` shows which ones are allowed
- **At the end** a change card for you: the files it changed, the problems it added and fixed,
  and whether the tests passed
- **Suggest mode** (default) only tells the agent. `init --mode block` also refuses exact copies,
  sends new security or crash problems back as errors, and won't let the task finish while
  they're there

### Tools the agent can call (MCP)

Hooks speak up on their own. With Attentry's MCP server, the agent can also ask:

- **find_existing**: "is there already a function that formats a date?" (`query`), or the code
  it's about to write (`code` and `file`). Answers with what exists, where, how often it's used,
  and whether to import it
- **check**: problems in its changes, or in the `files` it lists, with what this task added marked
  "(new in this task)", then clean-up (copies and unused code) apart
- **explain**: everything about the findings on one `file:line`: what the code does, why it
  matters, the fix in steps, and how to check. On a line without findings, it says which lines
  of that file have them

Built on the official MCP SDK: it speaks both the handshake protocol (2025 revisions) and
2026-07-28, and checks every call's arguments, so a wrong call comes back as an error the agent
can read and fix. All three tools only read.

The plugin adds them. Without it, `init` prints the `claude mcp add` command.

A background Attentry keeps the repo in memory (never on disk), so a check after an edit rereads
only what changed: about 0.1s of work on a 150-file repo, 2s on a 2,000-file one (plus ~0.2s to
start the hook). It starts on first use and stops after a quiet half hour. Its first read of the
repo takes about 10 s per 1,000 files; the agent doesn't wait for it. Attentry says it's still
reading, and checks the edits made meanwhile once it's done. Hooks, MCP tools and the editor ask
the same one, so the repo is read once and they agree on what's there and what this task added; with two agents in one repo, each hears only
about the files it edited. It proves it's Attentry on every answer (a key in `~/.attentry` only you
can read), so nothing else holding its address can talk to your agent.

## In your editor

`editors/vscode` is an extension for VS Code, Cursor, Windsurf and Antigravity. Build it with
`npm install && npm run package` in that folder, then install the `.vsix` (Extensions →
"..." → Install from VSIX). Other editors (JetBrains, Zed, Neovim) can run `attentry lsp` as a
language server. Its findings come from the repo's background Attentry, so the editor shows exactly
what your agent hears.

- Squiggles on **your changes** by default; click the status bar for the whole repo
- Hover a squiggle: what the code does in plain words, what can go wrong, how to fix and check.
  Built from the code itself, so it costs no AI credits
- Security and crash risks are errors, things that will break are warnings, clean-up is info
  (faded for unused code). Editors' agents read errors and warnings, so they see real problems
  while they work, and nothing is spent on clean-up
- Light bulb: delete unused code (the only automatic fix), copy the fix for your agent, ignore
  with a reason, or "not useful" (a rule marked on more than 10% of its findings becomes a hint)
- A line at the top of hotspot files: make small changes there, and test after each
- The Attentry panel, top to bottom: what's wrong in your changes (or the whole repo), Claude Code
  (connect it in one click; then suggest or block, and how its task is going), and one line on the
  last check. Hints and automatic checks are in Settings

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
- How to test Attentry by hand (features, security, load): [docs/TESTING.md](docs/TESTING.md)
