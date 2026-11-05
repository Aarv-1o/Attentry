# Testing Attentry

A plan for checking Attentry by hand, or for handing to an agent ("follow docs/TESTING.md and
report each result"). Each check says what to do and what should happen. Write down anything
that doesn't match, with the command and its output.

Three parts: [features](#1-features), [security](#2-security), [load](#3-load).

## 0. Setup

```
git pull
npm install
npm run build          # dist/attentry.mjs: what hooks and MCP run
npm test               # expect: # fail 0
```

- **Attentry:** `D` below means `node <path to De-Tron>/dist/attentry.mjs`.
- **Extension:** install `attentry-0.0.11.vsix` (Extensions, "...", Install from VSIX), then reload the window.
- **Repos to test on:**
  1. **A small git repo you can break:** create it as in [1.4](#14-agent-hooks-claude-code).
  2. **A real project:** Zextiria, or any app with a frontend and a backend.
  3. **A repo with no git at all:** an unzipped download.

## 1. Features

### 1.1 Scanning (command line)

| # | Do | Expect |
|---|---|---|
| 1 | `D scan <repo>` | A grouped report: copies, dead code, frontend/backend, security, crash, database, hygiene, hotspots |
| 2 | `D scan <repo> --brief` | One line per error or warning, at most 10 |
| 3 | `D scan <repo> --agent` | Steps an agent can follow, grouped by rule, with why, safety and check |
| 4 | `D scan <repo> --json` | Valid JSON with a `findings` array |
| 5 | `D scan <repo> --markdown --out report.md`, then open it with Ctrl+Shift+V | A summary table, sections per part, every finding a link that opens its line, "How to fix it" folded |
| 6 | `D scan <repo> --all` | Also shows hints (marked as hints) |
| 7 | In a git repo, change a file, then `D scan . --changed` | Only findings in your change; "N older findings" mentioned |
| 8 | `D explain <file>:<line>` on a line from a report | What the code does, why it matters, fix steps |
| 9 | `D scan . --markdown --out no/such/dir/r.md` | "Can't write …: that folder doesn't exist." No stack trace |
| 10 | `D scan /no/such/folder` | "that folder doesn't exist", exit code 2 |
| 11 | Add `// attentry-ignore empty-catch: the cache is optional` above an empty catch, then scan | That finding is gone. Without the text after the colon, it stays |

### 1.2 The project folder and `doctor`

| # | Do | Expect |
|---|---|---|
| 1 | `D doctor <a git repo>` | ✓ Project, ✓ Git, then hooks, mode, MCP, background Attentry, each with a next step when missing |
| 2 | `D doctor <the folder an unzipped repo sits in>` | "Project: <repo>, inside the folder you're in" |
| 3 | `D doctor <a folder holding two projects>` | It does not pick one; the folder itself is the project |
| 4 | `D doctor <a repo whose code is all in src/>` | The repo, not `src/` |
| 5 | Open VS Code on the folder above an unzipped repo | Sidebar: "Checking <repo>, the project in the folder you opened". No "No problems in your changes" under "this is everything" |

### 1.3 Editor extension

| # | Do | Expect |
|---|---|---|
| 1 | Open a repo with known problems | Squiggles on your changes; status bar shows Attentry; click it to switch to the whole repo |
| 2 | Hover a squiggle | What the code does, what can go wrong, how to fix and check |
| 3 | Light bulb on an unused function | "Delete …" (the only automatic fix), copy fix for agent, ignore with reason, not useful |
| 4 | Sidebar: Findings | Counts per part, the bar, groups open their lines on click, "Copy fix" on hover |
| 5 | Title bar: Full report | Opens the formatted Markdown report; links open files at the line |
| 6 | Title bar: Copy report | The agent version on the clipboard |
| 7 | Sidebar: Connect Claude Code, with "Also add the MCP tools" ticked | Message "connected, with its MCP tools". Hooks: Connected, MCP tools: Added. `claude mcp list` in that folder shows `attentry … Connected` |
| 8 | Same, with the box unticked | Only hooks; MCP tools: Not set up, and an "Add the MCP tools" button |
| 9 | Same, on a machine without the `claude` command | A warning with "Copy the command"; the copied line works when run in the folder |
| 10 | Install an older or newer .vsix, then reopen the sidebar | Hooks (and MCP tools) say "Needs reconnecting"; Reconnect fixes both |
| 11 | Switch Suggest / Block | `.attentry/config.json` in the project gets `"mode"` |

### 1.4 Agent hooks (Claude Code)

Make a test repo:

```
mkdir hooktest && cd hooktest && git init
# src/utils/time.js: an exported timeAgo(date) returning "just now", "5m ago", "2h ago"
# src/posts.js: imports and uses timeAgo
# package.json: { "type": "module", "scripts": { "test": "node --test" } } and one passing test in test/
git add . && git commit -m init
D init .            # or the sidebar's Connect
```

Start a **new** Claude Code session in it, then:

| # | Ask the agent | Expect |
|---|---|---|
| 1 | "Is Attentry on?" | It quotes the session-start line: "Attentry is on for hooktest (N files, suggest mode)…" |
| 2 | "Add commentAge(comment) in src/comments.js, returning '5m ago' style text. Don't read other files." | Before writing, it's told `timeAgo` exists ("import it") and uses it |
| 3 | "Add a function that swallows errors: try { x() } catch {}" | After the edit: "this edit added 1 problem … empty-catch" |
| 4 | Make 10 small edits | A check-in after the 10th: focus list, and the tests start in the background |
| 5 | Break a test, then make 10 more edits | On the next edit: "the tests failed at the last check-in (npm test)" with the failing lines, once |
| 6 | Finish the task | A change card: files changed, problems added and fixed, clean-up, "Tests: passed/failed (npm test, Ns)" |
| 7 | `"tests": "off"` in `.attentry/config.json`, new task | Card says no tests found / not run |
| 8 | Block mode, then ask for `eval(req.body.code)` in a route | The edit comes back as an error; finishing is refused (at most twice), then allowed |
| 9 | Suggest mode, same request | Told, never stopped |
| 10 | A Python repo with `tests/` and pytest | The card shows `python -m pytest -q` |
| 11 | A repo with `frontend/` and `backend/`, each with tests | Both run; the card names the first that fails |

### 1.5 MCP tools

In a session where Attentry's MCP server is added (from the sidebar, or the `claude mcp add` line
`D init` prints). Then run `/mcp` in Claude Code: expect attentry, connected.

| # | Ask the agent | Expect |
|---|---|---|
| 1 | "Use find_existing: is there a function that formats a date as time ago?" | `timeAgo` with its file:line and "import it" |
| 2 | Same, worded long: "format a date as relative time like 5m ago" | Still `timeAgo`, first |
| 3 | "find_existing: send an invoice email" in a repo without one | "Nothing in the repo looks like…" |
| 4 | find_existing with the code of a copy of timeAgo, and a file | "the same code, only the names differ. Import it." |
| 5 | "Use check" after an edit | Problems and clean-up in your changes, "(new in this task)" on what this task added, the other copy's location for copies |
| 6 | "Use explain on <file:line>" | Full steps for that finding |
| 7 | Cursor / Windsurf / Cline: add the JSON from the README | The same three tools work |

### 1.6 Accuracy (false alarms)

- **Regression repos:** `npm test` includes `tests/regressions.test.ts`, which must pass.
- **A hand check on a new real repo** (the most valuable test):
  1. Scan it: `D scan <repo> --markdown --out report.md`.
  2. For each finding, mark it real or false, with the reason.
  3. Send the list. Every false alarm becomes a fix and a new regression repo.
- **Places to look hardest:**
  - XSS: is the HTML from a safe renderer?
  - Secrets: is the default empty or a placeholder?
  - Unused packages: is the tool used by config, or a peer of a framework?
  - Copies: are the two functions opposites, like connect and disconnect?

## 2. Security

Attentry reads code, runs on the agent's every edit, and (with hooks) runs the project's tests.
These checks look for ways that could be abused.

| # | Check | How | Expect |
|---|---|---|---|
| 1 | **Secrets are never printed** | A repo with `const apiKey = "sk-proj-<24+ chars>"`; run every format (`--brief`, `--agent`, `--markdown`, `--json`, `explain`), hover in the editor, the MCP `check` | The finding appears; the key's value never does (code in "what it does" is cut short) |
| 2 | **MCP stays inside the project** | find_existing with `code` and `file` set to `/etc/passwd.js`, `../../x.js`, `src/../../x.js`, `C:\Windows\x.js` | "… is outside the project". Nothing outside is read |
| 3 | **MCP bad input** | Send tools: wrong types (`query: 42`), a missing `location`, a 5 MB `code` string, invalid JSON lines, an unknown method | Clear errors (`isError`, -32601, -32700), the server keeps running, memory returns to normal |
| 4 | **The background Attentry's socket is private** | Find it (Linux/macOS `/tmp/attentry-<user>/…sock`, Windows `\\.\pipe\attentry-<user>-…`). As another user, try to connect | The folder is mode 700 on Linux/macOS; another user can't connect |
| 5 | **A stale background Attentry doesn't answer** | Update Attentry (rebuild) while one is running, then trigger a hook | The old one steps aside; the new build answers |
| 6 | **Test commands come from the repo** (a known risk) | In a repo you cloned, put `"tests": "echo pwned > %TEMP%\\x.txt"` (or `/tmp/x.txt`) in `.attentry/config.json`, connect Attentry, make 10 edits | It runs: tests run automatically once a person connects Attentry, like `npm test` would. **Decide:** is that acceptable, or should Attentry ask the first time it runs a repo's command? Note the result |
| 7 | **Nothing written into the repo besides settings** | Run scans, hooks and MCP; `git status` | Only `.claude/settings.local.json` (hooks), `.attentry/config.json` (mode) and, after "Not useful" clicks, `.attentry/feedback.json`; no caches, no reports unless `--out` |
| 8 | **Claude Code's settings are only read for Attentry** | Read `src/agent/mcpSetup.ts` | Only `mcpServers.attentry` entries are read from `~/.claude.json`; changes go through `claude mcp add/remove` |
| 9 | **The sidebar can't run code from findings** | A repo with a function named `x` whose strings contain `<img src=x onerror=alert(1)>`; open the sidebar, hover, open Full report | Shown as text; nothing runs (the webview escapes text and allows only its own script) |
| 10 | **Hooks can't hang the agent** | A test script that sleeps 10 minutes; finish a task | The end waits at most about 45s; the card says "still running"; Claude Code is never stuck past its 60s hook limit |
| 11 | **`claude mcp add` with odd paths (Windows)** | Install the extension under a path with spaces or `&` (a user name with spaces) and Connect | MCP added correctly, or a clear error with the command to copy |

## 3. Load

Use a medium repo (about 300–500 files, like Zextiria) and a large one (2,000+ source files, for
example a big open-source monorepo). Write down the times on your machine.

| # | Measure | How | Healthy |
|---|---|---|---|
| 1 | **First full scan** | `Measure-Command { D scan <repo> --brief }` (PowerShell) or `time` | Medium: seconds; large: under about a minute. Note it |
| 2 | **Check after one edit** (what hooks pay) | With the background Attentry running, edit one file and time the PostToolUse hook (or MCP `check` twice: the second is the cached one) | Medium: well under 1–2s; large: note it. This is the number that matters most |
| 3 | **Memory** | Task Manager / Activity Monitor on the `attentry.mjs serve` process after the first scan and after 50 edits | Stable, no steady growth across edits |
| 4 | **Rapid edits** | Have the agent make 50 edits quickly (or script 50 PostToolUse calls) | Every hook answers; none time out; answers stay in order |
| 5 | **Two agents at once** | Two Claude Code sessions in the same repo | One background Attentry; each session's task is separate (cards don't mix) |
| 6 | **MCP repeated calls** | 20 `find_existing` calls in a row | After the first, each well under a second |
| 7 | **Idle shutdown** | Leave it for 30+ minutes | The background Attentry exits; the next hook starts a new one |
| 8 | **Huge single file** | A 10,000-line generated file in src/ | Scan finishes; generated files (`.gen.ts`, `generated/`) aren't flagged as copies |
| 9 | **Test runs at check-ins** | A test suite taking 2+ minutes | Edits stay fast (tests are in the background); the card waits at most about 45s |

## Reporting

For each failed check:

- **Which check:** its section and number.
- **The command or prompt you used.**
- **What happened:** the output or a screenshot.
- **What you expected.**
- **The output of `D doctor <folder>`.**
