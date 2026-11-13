# Attentry

You ask an AI agent for a feature, and a minute later it has written a few hundred lines. They
run, they look right, and nobody reads them. Somewhere in there is a route anyone can call without
logging in, a `JSON.parse` that crashes on bad input, or a third copy of a helper the repo already
had.

Attentry reads that code for you, while the agent is still working. It runs on your machine, uses
no AI, and talks to the agent directly: when an edit adds a security hole or a crash risk, the
agent hears about it right away and fixes it before moving on. When the task is done, you get a
short card that says what changed and whether anything new went wrong. A clean edit costs
nothing: the agent hears nothing at all.

It works with **Claude Code** and **Codex**, in VS Code, Cursor, Windsurf and Antigravity.

![A real Claude Code session with Attentry: the agent adds a route, Attentry checks each edit, and the change card shows no problems added and 10 fixed](site/assets/demo.gif)

*A real session on the [demo repo](https://github.com/Aarv-1o/attentry-demo), sped up where the
agent was thinking. Nothing in it is staged.*

- Website: [attentry.js.org](https://attentry.js.org)
- Try it first: [attentry-demo](https://github.com/Aarv-1o/attentry-demo), a small notes app with
  problems planted on purpose, and what Attentry says about each one
- Reads JavaScript, TypeScript (including JSX and TSX), Python and Astro

## Get started

Install the extension from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=attentry.attentry), or
from [Open VSX](https://open-vsx.org/extension/attentry/attentry) if you use Cursor, Windsurf or
another VS Code fork. Then open the **Attentry** panel in the sidebar and connect your agent.

### Claude Code

Click **Connect Claude Code**. That's all the setup there is: Attentry is added to Claude Code for
every project, and the extension keeps it up to date. Start a new Claude Code session and ask for
anything.

### Codex

Click **Connect Codex**. The panel only shows this if you use Codex on this computer.

Then start a new Codex session. Codex asks whether to trust **attentry-hooks**: say yes. You can
also do it later by typing `/hooks` in Codex. Codex never runs a plugin's hooks until you've
trusted them, and that's a good rule, so Attentry can't skip this step for you.

You approve once. Attentry's updates don't ask again (see
[How Codex support works](#how-codex-support-works) for why). If the hooks ever stop running, for
example because they were never trusted, the panel says so and tells you what to do.

Codex support is new in 0.1.4. It works in the Codex command line and in the Codex extension for
VS Code. Two things to know:

- Block mode (below) is tested with Claude Code only. With Codex, use suggest mode for now; block
  mode for Codex comes in 0.1.5.
- Attentry runs Codex's plugins with the Attentry inside the editor extension, so keep the
  extension installed.

## What the agent hears, and when

Attentry speaks up at a few moments during a session, and stays quiet the rest of the time.
Claude Code and Codex hear the same things.

- **When a session starts**, the agent gets one line saying Attentry is on.
- **When you send a request**, the agent is told about code in the repo that matches it, for
  example "the repo already has `timeAgo` in src/utils/time.js". That way it builds on what
  exists instead of writing it again.
- **When the agent finishes a plan** (Claude Code), Attentry reads it and points out anything the
  repo already has: a helper the plan would write again, a route that already exists, a file that
  changes all the time, or a plan too big to do in one go. You can also ask for this check by
  typing `/attentry:plan`.
- **Before an edit**, if the agent is about to write a function the repo already has, it's told
  where the existing one is and how often it's used.
- **After an edit**, the agent hears about the problems that edit added, each one once. Problems
  that were in the repo before the task started are left out, so old issues never nag.
- **Every 10 edits** there's a short check-in, and your tests run in the background.
- **At the end of the task** you get a change card: the files the agent changed, the problems it
  added or fixed, and whether the tests passed.

### Suggest or block

By default Attentry only makes suggestions: the agent hears about problems and decides what to do.
In block mode it also refuses exact copies of existing functions, and won't let a task finish while
it has added a security or crash problem. Switch modes in the panel. Block mode is for Claude Code
for now (Codex in 0.1.5).

### Tools the agent can call

Besides speaking up on its own, Attentry gives the agent four tools it can call when it wants to:

- `find_existing` looks for a function that already does a job, from a short description or from
  the code the agent is about to write.
- `check` lists the problems in the agent's changes, or in the files it names, and marks the ones
  this task added.
- `explain` gives the full story of the findings on one line: what the code does, why it matters,
  how to fix it and how to check the fix.
- `check_plan` runs the plan check on demand.

All four only read. They're built on the official MCP SDK and validate every call, so a bad call
comes back as an error the agent can read and correct.

### Tests

Attentry looks for your test command (`npm test`, `pnpm test`, pytest and so on, in each app of
the repo). You can set your own in `.attentry/config.json` with `"tests": "make check"`, or turn
tests off with `"tests": "off"`. A run is stopped after 300 seconds unless you change
`"testTimeoutSeconds"`.

Because a test command can run anything, Attentry only runs commands you've allowed. Connecting
Claude Code or Codex in the panel allows the open repo's current ones. In another repo, or after a
test command changes, the change card says the tests weren't run, and the panel shows an **Allow
tests** link. `attentry doctor` shows what's allowed.

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

The Attentry panel shows what's wrong by category, whether Claude Code and Codex are connected,
how the current task is going (under the agent doing it), and when the repo was last checked.

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
that Attentry is set up correctly, for Claude Code and Codex, and tells you how to fix anything
that isn't.

To use Attentry with Claude Code without the extension, build it and set up the hooks in a repo:

```
npm run build
node dist/attentry.mjs init path/to/your/repo
```

## How it runs

Attentry runs on your machine and only reads your repo. Your code never leaves it.

A background process keeps the repo in memory, never on disk, so a check after an edit only
rereads what changed. That takes about 0.1 seconds on a 150-file repo and about 2 seconds on a
2,000-file one. The first read takes roughly 10 seconds per 1,000 files, and the agent doesn't wait
for it: edits made in the meantime are checked once it's done. The process stops after half an
hour without use.

The hooks, the tools and the editor all talk to the same process, so they always agree. If two
agents work in the same repo, each one only hears about its own edits. Every answer is signed with
a key stored in `~/.attentry` that only you can read, so nothing else can pretend to be Attentry.

### How Codex support works

Codex has the same moments as Claude Code (session start, a request, before and after an edit,
the end of a turn), and Attentry answers them the same way. Three things are different, and here
is how Attentry handles each.

**Codex edits with patches.** Claude Code sends the file and the text it replaces. Codex sends one
`apply_patch` call that can add, change, move or delete several files at once, in its own patch
format without line numbers. Attentry reads that format, works out what each file will look like
after the patch, and checks those files like any other edit.

**Codex asks you to trust hooks again whenever a plugin changes.** It fingerprints every file in
a plugin, so a plugin that carried Attentry would need approving again after every release. So the
extension gives Codex two plugins instead of one:

- `attentry-hooks` holds the hooks and a ten-line launcher, and nothing else. It never changes: a
  test in this repo pins its exact bytes. The launcher runs the Attentry inside the editor
  extension, whose location is kept in `~/.attentry/build.json` and updated when the extension
  updates. Codex sees the same plugin every time, so it keeps trusting it.
- `attentry` holds the tools and skills. It has no hooks, so it can change with every release
  without asking you anything.

**Codex doesn't fill in a plugin's folder for its tools.** Hooks can use `${CLAUDE_PLUGIN_ROOT}`,
but a plugin's MCP server can't, so the `attentry` plugin starts its server with a two-line loader
that reads the same `~/.attentry/build.json`. Codex starts it in your project, which is how it
knows which repo to check.

To tell whether Codex is running the hooks, Attentry notes when it installed them and when Codex
last ran one. A Codex session since the install without a word from the hooks means they're
waiting for your OK, and the panel and `attentry doctor` say so.

## More

- [SPEC.md](SPEC.md): what version 1 will do
- [AGENTS.md](AGENTS.md): rules for anyone, person or agent, working on this repo
- [docs/research.md](docs/research.md): the research behind the decisions
- [docs/TESTING.md](docs/TESTING.md): how to test Attentry by hand

Attentry is open source under the MIT licence. Made by [Aarv Singh Chauhan](https://aarv.is-a.dev/).
