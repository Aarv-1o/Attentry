# Rules for working on Attentry

Attentry exists to stop AI agents from making a mess. These rules come from the
mistakes we found in real AI-written repos. Every agent and human on this repo follows them.

## Before writing code

1. **Search first.** Before adding any function, search the repo for one that already
   does the job. Reuse or extend it. Never write a second `timeAgo`.
2. **No new package without a reason.** Say in the commit message why it's needed.
   Remove packages the moment nothing uses them.

## While writing code

3. **Nothing unused.** No dead exports, no "might need it later" code, no unused params.
4. **No leftover versions.** No `thing_v2.ts` next to `thing.ts`. Replace, then delete.
   Git keeps the history.
5. **Fail loudly.** No catch blocks that only log, no silent fallbacks, no empty catch
   without a comment saying why.
6. **Small files.** Split a file before it passes ~400 lines.
7. **Comments say why, never what.** If a comment repeats the code, delete it.

## Committing

8. **Small commits.** One idea per commit, about 200 changed lines max.
   Never mix a feature and a cleanup in one commit.
9. **Every commit passes** the tests, the type check, and `attentry scan` on this repo
   (once it exists).

## Rules (the product's checks)

10. **Every rule ships with fixtures:** examples it must flag *and* examples it must
    not flag. Use the false alarms from [docs/research.md](docs/research.md).
11. **Only structure-only fixes may be automatic.** Anything that changes behavior is a warning.
