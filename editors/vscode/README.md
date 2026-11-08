# Attentry

**Your AI agent writes the code. Attentry watches it.**

Attentry sits beside Claude Code and checks every edit it makes: security holes, crash risks,
copied and dead code. It tells the agent right after the edit, so it fixes the problem before you
see it, and shows you a change card when the task is done.

[attentry.js.org](https://attentry.js.org) · [GitHub](https://github.com/Aarv-1o/Attentry)

## Get started

1. Install this extension.
2. Open the **Attentry** panel in the sidebar and click **Connect Claude Code**. That adds Attentry
   to Claude Code for all your projects, and keeps it updated with this extension.
3. Start a Claude Code session and ask for anything.

## What Claude hears, and when

- **When you ask:** the code your repo already has for the request ("the repo already has
  `timeAgo` in src/utils/time.js"), so it plans with it instead of writing it again.
- **Before an edit:** if it's about to write a function the repo already has, where the existing
  one is.
- **After an edit:** only the problems this edit added, once each, in a few lines. A clean edit
  gets nothing at all.
- **At the end:** a change card for you: the files it changed, the problems it added or fixed, and
  whether the tests passed.

Suggest mode (the default) only tells Claude. Block mode won't let a task finish while it added a
security or crash problem.

## What it catches

- **Security, door by door:** routes, socket events, tRPC procedures, GraphQL resolvers and
  server actions with no login check, no owner check or no rate limit. Secrets in code, injection,
  XSS, CORS, weak password storage, unverified JWTs.
- **Crash risks:** async handlers with no error handling, `JSON.parse` on outside data, exiting
  the process mid-request.
- **Frontend and backend:** calls to routes that don't exist, the wrong method, routes nothing
  calls any more.
- **Database:** money stored as floats, queries inside loops, trees fetched one level at a time.
- **Copies and dead code:** exact and drifted copies, unused files, packages and functions.
- **Hotspots:** complex files that change all the time.

JavaScript, TypeScript and Python. What it can't check yet, it says so: "no issues" never means
"not looked at".

## In the editor

- Squiggles on your changes (or the whole repo), each explained in plain words, read from the code
  itself: no AI, no credits.
- The panel shows what's wrong by category, whether Claude Code is connected, and how its task is
  going.
- The light bulb: delete unused code (the only automatic fix), copy the fix for your agent, or
  ignore with a reason (`// attentry-ignore rule: reason`).

## Private by design

Attentry runs on your machine and only reads your repo. Your code never leaves it. Its tools are
read-only, which is why Connect lets Claude call them without asking each time.

Works in VS Code, Cursor, Windsurf and Antigravity. Free and open source (MIT).
