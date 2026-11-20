# Tests in Attentry: plan (2026-11-20, built)

Branch: `Test`. Nothing here is merged or released.

**Status (2026-11-20): all seven steps are built and tested**, each against real open-source repos
(node-express-boilerplate, fastify/demo, full-stack-fastapi-template, Flask's tutorial,
Django-Styleguide-Example, nestjs-realworld, Hono's examples). Changes from the plan below:
- Step 1 also reads Django's `reverse("name")`, tests that build their own app around a router,
  and a project's own inject helper.
- Step 2: jest and vitest find related tests themselves (`--findRelatedTests`, `vitest related`);
  Attentry's own import walk is for pytest and `node --test`.
- Step 3: the owner check is worded "if only the owner may do this", since anyone may like a post.
- Step 7 was built before step 6: the panel's switch needs it.
- Testing it found and fixed: a crash on wrapped Django views (in 0.1.7), test-built apps counted
  as product routes, and several route-reading gaps (Express routers mounted in a loop,
  `@fastify/autoload`, `from . import auth`, every Django `include()` form). The research behind it is in
`D:\detron\books\test\reading-notes.md` (six testing books, read in three passes).

## The idea in one paragraph

Attentry already checks the plan and every edit. It doesn't yet say what tests a change needs,
or show which routes have no test. This adds both, without a model and without Attentry ever
calling the app itself: Claude writes the tests as normal test files, Attentry runs the
project's allowed test command and reads the results, and a new **Tests** section in the panel
shows what's tested and what isn't.

## What's decided

- **Attentry never starts the app or calls routes.** Running the app would use the real `.env`
  (real database, email, payment keys). Route tests are written in the repo with the
  framework's in-process client (supertest, FastAPI `TestClient`, the Django test client) and run
  through the test command the person allowed. Its tools stay read-only.
- **Claude doesn't have to tell Attentry when a section is done.** Attentry works out step
  boundaries from the edits (the plan names files and routes per step).
- **Attentry runs the tests, not Claude.** Claude hears only failures, in a few lines. Passing
  tests cost Claude nothing.
- **Few suggestions.** At most 5 test lines per plan, only high-value ones (security per route,
  the test that reproduces a bug). A switch turns test suggestions off.
- **We build, then judge.** Defaults below are picked so we can try it; any of them can change.

## Defaults picked for the first build (open to change after trying it)

| Question | Default for now |
|---|---|
| Push Claude at the end to write missing planned tests? | No: the change card shows "3 planned, 2 written". Revisit after trying it. |
| Where the section goes | Under Findings, above Claude Code |
| Runners for "Run for this file" | vitest, jest, pytest; others use "Run all" |
| "Try it yourself" lines on the change card | Not in the first build |
| Codex | Claude Code first (Codex has no plan mode; it hears plans only via `check_plan`) |

## What gets built, in order

Each step is one small commit (AGENTS.md: about 200 lines, one idea).

1. **Route coverage** (`src/testing/coverage.ts`): which routes a test file calls. Same matching
   as frontend calls to routes (`src/rules/crossStack`: `fullRoutes`, `callUrl`), applied to
   test-client calls: `request(app).delete("/api/notes/1")`, `client.get("/items/3")`,
   `self.client.post(...)`, Fastify `app.inject`, Hono `app.request`; Next.js tests reach a
   route by importing its handler. Output: each route → the tests that call it. Tests in
   `tests/testCoverage.test.ts`, inline repos like the cross-stack tests: routes covered and
   not, and false alarms that must not count (a URL in a comment, a mocked fetch, a script
   that isn't a test). Not yet: Django `reverse("name")` URLs, and tests that mount one router
   on a bare app (the path then lacks the real prefix).
2. **Tests for one file** (`src/testing/select.ts`): the test files that import a source file,
   directly or through other files (the index already has imports), and the command line for
   each runner to run just those (`vitest run a b`, `jest a b`, `pytest a b`).
3. **What a plan needs** (`src/testing/suggest.ts`): from the plan's routes and the repo's
   facts, up to 5 test lines, worst risk first, using the rules in the reading notes:
   - a route with no login check → "no login → 401"
   - a route taking an id → "user B on user A's object → 403/404, every method"
   - an admin route → "regular user → 403"
   - a create/update passing the body to the model → "extra field (`isAdmin`) ignored"
   - a plan that fixes a bug → "first, a test that reproduces it"
   Added to the plan message Attentry already sends (`planMessage` in `src/agent/hooks.ts`).
4. **Plan steps** (`src/testing/steps.ts`): split the plan into steps with the files and routes
   each names; notice when edits move to the next step's files; run the tests in the background
   then (instead of only every 10 edits; `runTests` in `src/agent/tests.ts`).
5. **The change card line**: "Tests: 3 planned, 2 written, passed" (`src/agent/card.ts`): planned
   tests matched to test files written in the task, via step 1.
6. **The Tests section** in the panel (`editors/vscode/src/sidebar.ts`, `media/sidebar.js`):
   last run and result; Run all; Run for this file; routes with no test, worst first (no login
   check first); this task's planned tests; the On/Off switch for suggestions.
7. **Settings and the switch**: `testSuggestions: true | false` in `.attentry/config.json`
   (`src/agent/config.ts`), read by steps 3 and 5.

## Not in this build

- Running the app, a browser, or anything outside the allowed test command.
- Writing tests itself (Claude writes them).
- Coverage percentages (the books agree a number becomes a goal; we show untested routes
  instead).
- Codex plan hooks.

## How we'll know it works

- Unit tests per step (`tests/testCoverage.test.ts`, `tests/testSelect.test.ts`,
  `tests/testSuggest.test.ts`, `tests/testSteps.test.ts`), with inline repos (`makeRepo`).
- A real run on `attentry-demo`: plan "add DELETE /api/notes/:id", check the plan message names
  the 3–4 tests, Claude writes them, the panel shows the route as covered, the card counts them.
- The noise check: on 3 real repos, how many suggestions would a developer act on? Under 10%
  ignored, like the rules.

## Folders created on this branch

- `src/testing/`: the new module (steps 1–4).
