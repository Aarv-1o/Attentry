# Attentry

Attentry checks the code your AI agent writes. It works with Claude Code: after each edit, it
tells Claude about any security hole, crash risk, copied function or dead code that the edit added,
so Claude can fix it straight away. When the task is done, you get a short summary of what changed.

Website: [attentry.js.org](https://attentry.js.org). Source: [GitHub](https://github.com/Aarv-1o/Attentry).

## Getting started

1. Install this extension.
2. Open the Attentry panel in the sidebar and click **Connect Claude Code**. This adds Attentry to
   Claude Code for all your projects, and the extension keeps it up to date.
3. Start a Claude Code session and ask for whatever you need.

## What Claude hears, and when

- When you send a request, Claude is told about code in your repo that matches it, so it builds on
  what's already there instead of writing it again.
- Before an edit, if Claude is about to write a function the repo already has, it's told where the
  existing one is.
- After an edit, Claude hears about the problems that edit added, each one once. A clean edit gets
  no message at all.
- At the end of the task you get a change card: the files Claude changed, the problems it added or
  fixed, and whether the tests passed.

By default Attentry only makes suggestions. In block mode, a task can't finish while it has added
a security or crash problem.

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

The Attentry panel shows what's wrong by category, whether Claude Code is connected, and how its
current task is going.

## Privacy

Attentry runs on your machine and only reads your repo. Your code never leaves it. The tools it
gives Claude only read, which is why Connect lets Claude use them without asking you each time.

Works in VS Code, Cursor, Windsurf and Antigravity. Free and open source under the MIT licence.
