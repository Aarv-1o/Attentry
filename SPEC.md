# Attentry V1 Spec

## Problem

AI agents write code fast, but they make a mess of the codebase:
they copy helpers that already exist, leave dead files and packages behind,
fail silently, and pile everything into giant files.
Our baseline scan of 3 real AI-written repos found that the biggest problems
come from **the agent not knowing what already exists**, not from single bad lines
(see [docs/research.md](docs/research.md)).

## Who it is for

- **Developers** using AI agents: show issues, let them decide (Review mode).
- **Vibe coders** who can't judge warnings: fix safely and explain simply (Auto-fix mode).

## V1 scope

| In V1 | Not in V1 |
|---|---|
| JS/TS (frontend + Node backend), Python and Astro | Other languages (Java, C/C++, Go, Vue, Svelte…): at the end, one adapter each. Until then, scans say what they skipped |
| Works with every agent (see below) | VS Code / editor UI |
| Codebase checks + the line rules that passed our hand-check | Project planner, DB mind maps |
| Safety layer (checkpoint, tests, type check, undo) | General security scanning (Semgrep, CodeQL do this): Attentry checks what AI agents get wrong, using its route map |
| Change card | Our own paid agent |

## Agent compatibility

One core engine. Thin adapters on top, so adding an agent means adding a small adapter.

| Layer | What it does | Works with |
|---|---|---|
| CLI (`attentry scan`, `--changed`, `--brief`, `explain`) | Any agent that can run a command can use it | Every agent |
| Language server (`attentry lsp`) + extension | Squiggles, plain-word cards and safe fixes in the editor; editors' agents read the errors and warnings | VS Code, Cursor, Windsurf, Antigravity (extension); JetBrains, Zed, Neovim (LSP) |
| MCP server | Tools like "find existing function" and "check my changes" | Claude Code, Cursor, Copilot, Codex, Gemini CLI, Windsurf, Cline… |
| Hooks (`attentry init`, `attentry hook claude`) | Run automatically: session start, before and after each edit, at the end. Built for Claude Code's format | Claude Code (Cursor and Copilot CLI load it); Codex, Gemini CLI next |
| Instruction files | `attentry init` adds a short block to AGENTS.md / CLAUDE.md / Cursor rules | Every agent that reads them |
| Git hook + CI | Checks every commit, whoever wrote it | Everyone |

## How it works

1. The agent edits a file. Attentry scans it locally. **Free.**
2. Findings pile up. At a checkpoint (every 10 edits, at task end, or "Focus here"),
   Attentry sends only the **sure** findings to the agent.
3. The agent fixes them as a **separate step**, never mixed with feature work.
4. Attentry runs tests and the type check. If they pass, the fix is kept. If not, it's undone.
5. Attentry shows a change card: what changed, why, and what it touches.

## Credits

| Part | Who | Cost |
|---|---|---|
| Scanning, index, hotspots | Attentry, locally | 0 |
| Safety checks | Attentry, locally | 0 |
| Fixing | The user's own agent, same session | User's credits |
| Change card facts | Attentry, locally | 0 |
| Change card summary | The user's agent, or a no-AI template | Tiny or 0 |

Optional later: bring-your-own API key, for scans with no agent running (cloned repos, CI).

## Checks

### Codebase checks (highest value)

| Check | What it finds |
|---|---|
| Reuse hint | Before the agent writes a helper, show it the matching function that already exists |
| Duplicate functions | Same logic in several files, fuzzy match, including across JS and Python |
| Dead files | Files nothing imports (e.g. `orchestrator_v2.py`) |
| Dead exports | Exported functions nobody uses |
| Unused packages | Dependencies nothing imports |
| Hotspots | Files that change often and are complex. Fix these first, leave stable code alone |
| Cross-stack | Frontend calls to missing API routes, backend routes nothing calls |

### Line rules (only the ones that scored well)

| Rule | Decision |
|---|---|
| Commented-out code | Auto-fix |
| Catch that only re-throws | Auto-fix |
| Dead private code (static proof only) | Auto-fix |
| Unused trailing params (private, not a framework signature) | Auto-fix |
| Comment repeats the code | Suggest as a batch |
| Catch that only logs (mainly frontend: user never sees the error) | Warn |
| Return default value on error | Warn |
| Empty catch with no "why" comment | Warn |
| Deep nesting, long param lists, vague names | Warn |

**Dropped after hand-check** (mostly false alarms): async without await,
tiny single-use helpers, assign-then-return.

Status: all of the above are built and report through `attentry scan`, plus the cross-stack
check, security and crash checks, database checks and hotspots. Every finding comes with why, fix steps, safe or ask
first, and how to check (`--agent`, `--json`). The reuse hint runs before each agent edit. The MCP
server (`attentry mcp`) gives agents find_existing, check and explain. Tests run at check-ins and at
the end, and the change card shows them. Not built yet: vague names, the safety layer's undo.

## Safety rules

- **Structure vs behavior.** Only structure-only fixes (no change in what the code does)
  can be automatic. Anything that changes behavior is always asked first.
- Git checkpoint before any fix. One fix per commit. Auto-undo if tests or types fail.
- No tests? Write characterization tests first (record what the code does now),
  or stay in Review mode.
- Only check new or changed code by default. Old code only on request.
- Only "sure" findings go to the agent automatically.

## Commit size guard

- Warn when a change grows much bigger than the task (many files, many lines).
- Suggest splitting it: cleanup commit, then feature commit.
- Attentry's own fixes always go in their own small commits.

## Success

- Precision of sure findings: **90%+** (measured on hand-labeled repos).
- Fix success: fixes that keep tests and types passing.
- Before/after "X" on our 3 test repos. Escrows-AI baseline: 8 duplicate groups
  (18 functions), 5 unused packages, 19 unused exports, 52 redundant comments,
  43 log-only catches.

## Tech choices

- **TypeScript on Node.** It installs with `npx`, has a mature MCP SDK, and
  a VS Code extension later needs TS anyway.
- **tree-sitter** for parsing all languages the same way.
- **git CLI** for checkpoints, history and hotspots.

## License

MIT. See [LICENSE](LICENSE).
