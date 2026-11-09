# Changelog

## 0.1.1

- The store page lists the supported backends, libraries and languages, and the ones Attentry can't check yet.
- The example in the "serverCommand" setting no longer shows a folder from the author's machine.
- One helper instead of two copies for finding the name a value is assigned to (found by Attentry's own scan).

## 0.1.0 (first public release, preview)

- **Connect Claude Code** installs Attentry's Claude Code plugin for all your projects, kept up to date with the extension, and lets Claude call Attentry's read-only tools without asking each time.
- With each request, Claude hears the code your repo already has for it. Plans are checked too: when Claude finishes one, writes its plan file, or when you type `/attentry:plan`.
- Security checks for Socket.io events, WebSocket messages, tRPC procedures, GraphQL resolvers and Next.js server actions, as well as routes. If your project uses a backend Attentry can't check yet, it says so.
- A simpler panel: findings by category, one Claude Code status, one line on the last check. Hints and automatic checks are settings.
- The new Watchtower A logo, links to attentry.js.org, and Share with a friend.
- Fewer false alarms, found by testing on real projects and real Claude sessions.

## 0.0.11

- Connect Claude Code also adds Attentry's MCP tools (an option, on by default), and the panel shows hooks and MCP tools separately, with "Add the MCP tools" when only the hooks are set up.
- Your agent's task shows the files it changed and its tests: passed, failed, running or not run yet.
- When the folder you opened holds one project (an unzipped repo), Attentry checks that project and says so.
- No more "this is everything" above "No problems in your changes".
- Files with a bare & in JSX (a link with a query string) are read in full.

## 0.0.10

- Full report opens as a formatted page: a summary table, every finding linked to its line, and how to fix it folded under each rule.
- Fewer false alarms: React isn't an unused package (JSX uses it with no import), a generated API client isn't copies, Alembic migrations aren't unused files, test fixtures aren't scanned, and a copy that only gained a docstring is an exact copy, with docstrings no longer listed as differences.

## 0.0.9

- Fewer false alarms. Functions that do opposite things (follow and unfollow, connect and disconnect) are no longer called copies. Each secret is listed once, and an empty default is a hint. Python `.find()` on XML or strings isn't a database query. JSON.parse in command-line scripts isn't a crash risk. Prettier, ESLint, Prisma and other tools set up by a config file aren't unused packages. Agent skill folders (.agents, .claude, .cursor) aren't scanned. A reason on the `except` line, an example inside a comment, and a multi-line comment explaining why are all respected.

## 0.0.8

- Connected agents now hear, before writing a function, when the repo already has one that does the same job.

## 0.0.7

- A quieter sidebar: one bar showing the mix of problems instead of four boxes, findings as dense rows (a shape per severity, the title in full, the code and its location below), Copy fix in place of the location on hover, tabs instead of boxed switches, and at most one filled button.

## 0.0.6

- The sidebar in three parts: Findings; Scanning (scan your repo, check automatically on or off, the agent's next check-in as 10 ticks); Your agent (connect Claude Code, suggest or block, how its task is going, live).
- Edits an agent makes on disk trigger a check too, not only saves in the editor.

## 0.0.5

- Faster: scans about 45% quicker, and a save re-checks only the files that changed (about 0.5s on a mid-size repo).

## 0.0.4

- A cleaner sidebar: counts at a glance, file name first, Copy fix on hover, empty groups folded into one line, Scan again / Full report / Copy report in the panel's title bar.
- Says when it can't tell what changed (the open folder isn't a git repo).
- The panel's script nonce comes from crypto, not Math.random() (found by Attentry).

## 0.0.3

- Fix: the extension stopped at startup ("command 'attentry.toggleShow' already exists"). The server's commands are now attentry.server.*.

## 0.0.2

- The Attentry sidebar: scan, your changes or the whole repo, findings by part, reports.
- Fix: the server didn't start in VS Code, so the status bar kept spinning.

## 0.0.1

First version: findings in the editor, your changes by default, plain-word cards, safe quick fixes.
