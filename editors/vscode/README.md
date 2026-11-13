# Attentry

You ask an AI agent for a feature, and a minute later it has written a few hundred lines that
nobody reads. Somewhere in there is a route anyone can call without logging in, a crash waiting
for bad input, or another copy of a helper the repo already had.

Attentry reads that code while the agent works. It runs on your machine, uses no AI, and tells
the agent the moment an edit adds a security hole or a crash risk, so it fixes it straight away.
When the task is done you get a short summary of what changed. A clean edit costs no tokens: the
agent hears nothing at all.

Works with **Claude Code** and **Codex**.

![A real Claude Code session with Attentry: the agent adds a route, Attentry checks each edit, and the change card shows no problems added and 10 fixed](https://raw.githubusercontent.com/Aarv-1o/Attentry/main/site/assets/demo.gif)

- Website: [attentry.js.org](https://attentry.js.org). Source: [GitHub](https://github.com/Aarv-1o/Attentry).
- Try it first: [attentry-demo](https://github.com/Aarv-1o/attentry-demo), a small notes app with
  problems planted on purpose, and what Attentry says about each one.

## Getting started

1. Install this extension.
2. Open the **Attentry** panel in the sidebar and connect your agent:
   - **Claude Code:** click **Connect Claude Code**. That's all.
   - **Codex:** click **Connect Codex**, then start a new Codex session and say yes when Codex asks
     whether to trust **attentry-hooks** (or type `/hooks`). Codex runs a plugin's hooks only once
     you've trusted them. You do this once: updates don't ask again.
3. Ask your agent for whatever you need.

Attentry is added for all your projects, and the extension keeps it up to date.

## What the agent hears, and when

- When you send a request, the agent is told about code in your repo that matches it, so it builds
  on what's already there.
- Before an edit, if the agent is about to write a function the repo already has, it's told where
  the existing one is.
- After an edit, the agent hears about the problems that edit added, each one once. A clean edit
  gets no message at all.
- Every 10 edits there's a short check-in with your tests, and copies and unused code are listed.
- At the end of the task you get a change card: the files changed, the problems added or fixed,
  and whether the tests passed.

By default Attentry only makes suggestions. In block mode, a task can't finish while it has added
a security or crash problem. Block mode is for Claude Code for now; Codex gets it in 0.1.5.

## What it finds

- **Security:** routes, Socket.io events, tRPC procedures, GraphQL resolvers and Next.js server
  actions that don't check who's calling, don't check who owns the record, or have no rate limit.
  Also secrets written in the code, injection, XSS, CORS mistakes, weak password hashing and
  unverified JWTs.
- **Crash risks:** async handlers with no error handling, `JSON.parse` on data from outside, and
  handlers that exit the process.
- **Frontend and backend:** calls to routes that don't exist, calls with the wrong method, and
  routes nothing calls.
- **Database:** money stored as floats, queries inside loops, trees fetched one level at a time.
- **Copies and dead code:** exact and near copies of functions, unused files, packages and
  functions.
- **Hotspots:** complex files that change often.

## Supported backends and libraries

| What | Checked |
|---|---|
| Web frameworks | Express, Koa, Hono, Fastify, NestJS, Next.js (API routes), FastAPI, Flask, Django and Django REST Framework |
| Other ways in | Socket.io events, WebSocket (`ws`) messages, tRPC procedures, GraphQL resolvers (Apollo Server, GraphQL Yoga, Mercurius, graphql-tools), Next.js server actions |
| Frontend calls | fetch, axios (including base URLs), apisauce, superagent, generated API clients, Vite's dev proxy |
| Databases | Mongoose, Sequelize, TypeORM, Prisma, Knex, the Django ORM, SQLAlchemy, SQLModel, raw SQL |
| Languages | JavaScript, TypeScript (including JSX and TSX), Python, Astro |

Not checked yet: hapi, restify, AdonisJS, Elysia, h3/Nitro, LoopBack, Tornado, aiohttp, Sanic,
Litestar, Django Channels, and GraphQL written with type-graphql, NestJS GraphQL, Pothos,
Graphene, Strawberry or Ariadne. If your project uses one of these, Attentry tells you it couldn't
check it, rather than reporting that everything is fine.

## In the editor

Problems in your changes are underlined. Hover over one to see what the code does, what can go
wrong and how to fix it. The explanations come from the code itself, so they don't use any AI
credits. The light bulb can delete unused code, copy the fix for your agent, or ignore a finding if
you give a reason (`// attentry-ignore rule: reason`).

The Attentry panel shows what's wrong by category, whether Claude Code and Codex are connected,
and how the current task is going, under the agent doing it. If Codex hasn't run Attentry's hooks
yet, the panel says so and what to do.

## Tests

Attentry runs your tests at check-ins, but only commands you've allowed, because a test script can
run anything. Connecting an agent allows the open repo's current test command. In another repo, or
after the command changes, click **Allow tests** in the panel.

## Privacy

Attentry runs on your machine and only reads your repo. Your code never leaves it. The tools it
gives your agent only read, which is why Connect Claude Code lets Claude use them without asking
you each time. Codex follows its own approval settings, which Attentry doesn't change.

Works in VS Code, Cursor, Windsurf and Antigravity. Free and open source under the MIT licence.
