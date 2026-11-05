# Attentry

Finds the mess AI coding agents leave, right where the code is, in plain words.

- **Security:** routes anyone can call, other users' records reachable by id, secrets in code, injection.
- **Will break:** calls to routes that don't exist, errors that are swallowed, crash risks.
- **Database:** queries in loops, money stored as floats.
- **Clean-up:** copied code, dead code (faded, with a one-click delete when it's safe).

Every card says what the code does and what can go wrong, read from the code itself: no AI, no credits.

## How it works

- Shows **your changes** by default: what this branch or your uncommitted work added. Click the
  status bar to see the whole repo.
- Checks once when you open a folder, and again when you save.
- Security and crash risks are errors, things that will break are warnings, clean-up is info.
  Agents in Cursor, Copilot and Windsurf read errors and warnings, so they see the real problems
  while they work, and nothing is spent on clean-up.
- The light bulb has: delete unused code (the only automatic fix), copy the fix for your agent,
  ignore with a reason (`// attentry-ignore rule: reason`), and "not useful".

Works in VS Code, Cursor, Windsurf and Antigravity. Other editors (JetBrains, Zed, Neovim) can
run `attentry lsp` as a language server.
