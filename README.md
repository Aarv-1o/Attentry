# Attentry

Attentry checks the code your AI agent writes. It works with Claude Code: after each edit, it
tells Claude about any security hole, crash risk, copied function or dead code that the edit added,
so Claude can fix it straight away. When the task is done, you get a short summary of what changed.

Website: [attentry.js.org](https://attentry.js.org)

Attentry is in preview. It reads JavaScript, TypeScript (including JSX and TSX), Python and Astro.

## Install

Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=attentry.attentry), or from
[Open VSX](https://open-vsx.org/extension/attentry/attentry) if you use Cursor, Windsurf or another VS Code fork. Then open the Attentry panel in the sidebar and click **Connect Claude
Code**. That's all the setup there is. It adds Attentry to Claude Code for every project, and the
extension keeps it up to date.

## What Claude hears, and when

Attentry speaks up at a few moments during a Claude Code session, and stays quiet the rest of the
time. A clean edit gets no message at all.

- When a session starts, Claude gets one line saying Attentry is on.
- When you send a request, Claude is told about code in the repo that matches it, for example
  "the repo already has `timeAgo` in src/utils/time.js". That way it builds on what exists.
- When Claude finishes a plan, Attentry reads it and points out anything the repo already has: a
  helper the plan would write again, a route that already exists, a file that changes all the time,
  or a plan too big to do in one go. You can also ask for this check by typing `/attentry:plan`.
- Before an edit, if Claude is about to write a function the repo already has, it's told where the
  existing one is and how often it's used.
- After an edit, Claude hears about the problems that edit added, each one once. Problems that
  were in the repo before the task started are left out.
- Every 10 edits there's a short check-in, and your tests run in the background.
- At the end of the task you get a change card: the files Claude changed, the problems it added
  or fixed, and whether the tests passed.

By default Attentry only makes suggestions. In block mode it also refuses exact copies, and won't
let a task finish while it has added a security or crash problem. Switch modes in the panel.

### Tests

Attentry looks for your test command (`npm test`, `pnpm test`, pytest and so on, in each app of
the repo). You can set your own in `.attentry/config.json` with `"tests": "make check"`, or turn
tests off with `"tests": "off"`. A run is stopped after 300 seconds unless you change
`"testTimeoutSeconds"`.

Because a test command can run anything, Attentry only runs commands you've allowed. Connecting
Claude Code allows the current ones, and Attentry asks again if they change. `attentry doctor`
shows what's allowed.

### Tools Claude can call

Besides speaking up on its own, Attentry gives Claude four tools it can call when it wants to:

- `find_existing` looks for a function that already does a job, from a short description or from
  the code Claude is about to write.
- `check` lists the problems in Claude's changes, or in the files it names, and marks the ones this
  task added.
- `explain` gives the full story of the findings on one line: what the code does, why it matters,
  how to fix it and how to check the fix.
- `check_plan` runs the plan check on demand.

All four only read. They're built on the official MCP SDK and validate every call, so a bad call
comes back as an error Claude can read and correct.

## What it finds

**Security.** Routes with no login check, admin routes that don't check the role, records loaded
by id without checking who owns them, and logins with no rate limit. The same checks cover
Socket.io events, WebSocket messages, tRPC procedures, GraphQL resolvers and Next.js server
actions. In the code itself it looks for SQL, NoSQL and command injection, `eval`, SSRF, open
redirects, unsafe file paths, mass assignment, secrets written in the code, `.env` files in the
repo, XSS, CORS with credentials, leaked stack traces, weak password hashing, unverified JWTs and
`Math.random()` tokens. If your project uses a backend Attentry can't read yet (hapi or Elysia,
for example), it says so instead of reporting "no issues".

**Crash risks.** Async Express 4 handlers with no error handling, `JSON.parse` on data from
outside, and handlers that exit the process.

**Frontend and backend.** Calls to API routes that don't exist (with the route you probably
meant), calls with the wrong HTTP method, and routes nothing calls any more. It understands
Express, Koa, Hono, Fastify, NestJS, Next.js, FastAPI, Flask and Django on the backend, and fetch,
axios, apisauce, superagent, generated clients and Vite's proxy on the frontend.

**Database.** Money stored as floats, queries inside loops, trees fetched one level at a time, and
INSERTs without column names. It also flags `SELECT *`, `ORDER BY RAND()` and `LIKE '%x%'` as
hints. It works with Mongoose, Sequelize, TypeORM, Prisma, Knex, Django, SQLAlchemy, SQLModel and
raw SQL.

**Copies and dead code.** Exact and near copies of functions (showing what differs), including the
same logic written in both JavaScript and Python. Unused packages (with their size), unused files,
and functions nothing calls.

**Hotspots.** Complex files that change often, worked out from the git history, so you know where
a change is most likely to break something. This needs a git clone, not a downloaded zip.

**Code hygiene.** Errors that are ignored or only logged, commented-out code, comments that just
repeat the code, unused parameters and deep nesting.

To silence a finding, add a comment with a reason on its line or the line above:
`// attentry-ignore empty-catch: the cache is optional` (use `#` in Python). A comment without a
reason doesn't count.

## In the editor

The extension underlines problems in your changes, or in the whole repo if you click the status
bar. Hover over one to see what the code does, what can go wrong, and how to fix it. These
explanations come from the code itself, so they don't use any AI credits.

Security and crash problems show as errors, things that will break as warnings, and clean-up as
info. The light bulb can delete unused code (the only automatic fix), copy the fix so you can paste
it to your agent, or ignore the finding with a reason. If you mark more than 10% of a rule's
findings as not useful, that rule drops to a hint.

The Attentry panel shows what's wrong by category, whether Claude Code is connected, how its
current task is going, and when the repo was last checked.

The extension works in VS Code, Cursor, Windsurf and Antigravity. Other editors, such as JetBrains,
Zed and Neovim, can run `attentry lsp` as a language server.

## Command line

You need Node 22 or newer. From a clone of this repo:

```
npm install
npm run attentry -- scan path/to/your/repo
```

Useful options:

- `--changed` shows only what your branch or uncommitted work added.
- `--brief` prints at most ten lines, one per error or warning. This is the short version an agent
  needs.
- `--all` includes hints, the findings Attentry is less sure about.
- `--agent` prints each finding as steps an agent can follow.
- `--markdown` writes a report for a Markdown preview or a pull request comment. Add
  `--out attentry-report.md` to save it.
- `--json` prints the findings as JSON.

`attentry explain src/app.ts:42` explains the findings on one line, and `attentry doctor` checks
that Attentry is set up correctly and tells you how to fix anything that isn't.

To use Attentry with Claude Code without the extension, build it and set up the hooks in a repo:

```
npm run build
node dist/attentry.mjs init path/to/your/repo
```

## How it runs

Attentry runs on your machine and only reads your repo. Your code never leaves it.

A background process keeps the repo in memory, never on disk, so a check after an edit only
rereads what changed. That takes about 0.1 seconds on a 150-file repo and about 2 seconds on a
2,000-file one. The first read takes roughly 10 seconds per 1,000 files, and Claude doesn't wait
for it: edits made in the meantime are checked once it's done. The process stops after half an
hour without use.

The hooks, the tools and the editor all talk to the same process, so they always agree. If two
agents work in the same repo, each one only hears about its own edits. Every answer is signed with
a key stored in `~/.attentry` that only you can read, so nothing else can pretend to be Attentry.

## More

- [SPEC.md](SPEC.md): what version 1 will do
- [AGENTS.md](AGENTS.md): rules for anyone, person or agent, working on this repo
- [docs/research.md](docs/research.md): the research behind the decisions
- [docs/TESTING.md](docs/TESTING.md): how to test Attentry by hand

Attentry is open source under the MIT licence. Made by [Aarv Singh Chauhan](https://aarv.is-a.dev/).
