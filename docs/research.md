# Research behind Attentry

## The problem is real

- **GitClear:** with AI, code is written ~20% faster, but churn is ~50% higher,
  duplication ~30% higher, and refactoring ~80% lower.
- **CodeRabbit:** AI PRs had ~1.7x more issues than human PRs (10.83 vs 6.45),
  with readability the biggest gap.
- **Stack Overflow 2025:** 66% say AI code is "almost right, but not quite".
  45% say debugging it takes longer.
- **METR:** experienced devs expected AI to make them 24% faster. They were 19% slower.

## What existing tools miss

- AI reviewers (CodeRabbit, Qodo...) are noisy. Developers start ignoring all comments.
- Slop detectors (slopfighter, Distyll, deep-slop) only **report**. None prove a fix is safe,
  none explain changes, and none learn.
- Spec tools (Spec Kit, Kiro) plan well, but stop governing the code after the first generation.

## Lessons from the books

- **Fowler, *Refactoring*:** smells catalog (Lazy Element, Speculative Generality,
  Middle Man, Duplicated Code). Code used only by tests is dead: delete both.
  "Two Hats": never add features and refactor at the same time.
- **Ousterhout, *A Philosophy of Software Design*:** pass-through methods, shallow modules,
  "comment repeats code". Warns that functions split too small become hard to read.
  Too many exceptions add complexity, but masking errors is sometimes right.
- **Beck, *Tidy First?*:** delete dead code (git keeps it). Explaining variables
  often *help*. Keep tidying separate from behavior changes, in small batches.
- **Feathers, *Working Effectively with Legacy Code*:** write characterization tests
  (record what the code does now) before changing untested code.
  Without tests, preserve signatures and lean on the compiler.
- **Tornhill, *Your Code as a Crime Scene*:** hotspots = change frequency × complexity.
  Change history predicts defects better than complexity alone.
  Indentation is a cheap complexity measure that works in any language.

## Baseline scan (Oct 2026)

Repos: Escrows-AI (30k lines, JS/TS), Travscape (3.4k, Python + JS), BlogManager (600, Python + JS).

### Real problems found

- `timeAgo` written **7 times** in Escrows-AI. 4 exact copies, 3 that behave differently.
- `formatSize` and `formatFileSize`: identical.
- `_strip_json_state` (Python) and `stripJsonState` (JS): the same logic in two languages.
- 2 dead orchestrator files in Travscape (477 lines, ~19% of its Python).
- `blog.py` and `api.py` in BlogManager are near-copies (29% duplication).
- 5 unused packages in Escrows-AI (three.js + react-three: 43 MB), 19 unused exports.
- 43 catch blocks that only log. On the frontend the user never sees the failure.
- `InboxPage.tsx`: 2,252 lines, 12 revisions, the #1 hotspot.

### Hand-check results (real issues in a sample)

| Rule | Real | Result |
|---|---|---|
| Duplicate functions | almost all | keep, top priority, needs fuzzy matching |
| Commented-out code | 7/8 | keep |
| Unused trailing params | 2/3 | keep, skip framework signatures |
| Comment repeats code | ~9/12 | keep as batch suggestion |
| Log-only catch | ~4/6 | keep, mainly frontend |
| Default return on error | ~3/6 | warn only (some are correct fail-closed checks) |
| Pass-through wrapper | 1/4 | low value |
| Empty catch | 42 of 45 had a "why" comment | only flag ones with no comment |
| Async without await | ~1/8 | dropped |
| Tiny single-use helper | 0/3 | dropped |
| Assign-then-return | 0/6 | dropped |

### Known false alarms to avoid (use as must-not-flag fixtures)

- Pydantic model fields reported as "unused variables".
- FastAPI route functions reported as "unused functions".
- Webhooks and OAuth callbacks reported as "routes nothing calls".
- API paths built from constants (`${API}/usage`) missed by naive string matching.
- LangGraph node functions whose `state` param is required by the framework.
- `async` handlers that must return a promise to match an interface.

## Duplicate detection v1 results (Oct 2026)

Hand-checked on the 3 repos:

- **Sure (exact copies):** 11 of 11 real. Includes `escapeRegex` ×7 and `timeAgo` ×4.
- **Likely (similar + shared wording):** ~14 of 17 real. Found all 7 `timeAgo`
  versions, including the 3 drifted ones. False alarms: data templates, symmetric
  pairs like enroll/unenroll.
- **Maybe (same structure, different values):** "could share a helper" hints,
  e.g. fetchClients / fetchItems. Not checked for precision; never sent to agents automatically.

What made the difference:
- Comparing structure with every name blanked out (not just renamed).
- Requiring shared *wording* ("just now", error messages), not shared one-word codes.
- Judging how rare a value is relative to repo size: a value copied 10 times is the signal.
- Skipping icons, whole pages, module factories (120+ lines) and nested helpers.

## Dead code detection v1 results (Oct 2026)

- **Unused packages:** Escrows-AI: three, @react-three/drei, @react-three/fiber,
  @types/three, openai (51.5 MB). 5 of 5 real, same as knip. Attentry itself: none,
  after fixing a false alarm (grammar packages loaded through a runtime path string).
- **Unused files:** Travscape: both leftover orchestrator files. Escrows-AI and
  BlogManager: none.
- **Dead functions:** Escrows-AI: planAllows, getStorageLimitMB, brokerKillSwitch,
  stopScheduler. 4 of 4 real (only mentioned in a comment, or nowhere).
- **Dogfooding:** Attentry found `listSourceFiles` dead in its own code (only tests
  used it). Removed.

Known gaps:
- A file whose name is a common word (`blog.py`) counts as "mentioned" almost
  everywhere, so it's never reported. Safe, but it misses some dead files.
- Two functions with the same name hide each other: if one is used, both look used.

## First blind test: AgentinFlow (Oct 2026)

An Astro marketing site I hadn't tuned on. Attentry reported "no copies, no dead code"
after reading only 3 of 19 code files: the other 16 were `.astro`. A clean report
on a repo you mostly didn't read is the worst kind of false confidence, so scans now
list what they skipped.

Checked by hand: all 11 components are used, every CSS/JS file is referenced, both
packages are used, and the inline scripts don't repeat each other. So the repo really
is clean, but Attentry got that right by luck.

Lesson for adding Astro/Vue/Svelte: their imports end in `.astro`/`.vue`/`.svelte`.
A quick trial that ignored this produced 10 false "unused file" alarms.

## Line rules v1 results (Oct 2026)

| Rule | Escrows-AI | Travscape | Checked by hand |
|---|---|---|---|
| Errors only logged (browser) | 22 | 3 | real: the user never sees the failure |
| Errors silently ignored | 16 | 3 (maybe: named Python errors) | 13 of Escrows' 16 are `catch { /* ignore */ }` |
| Errors turned into default values | 7 (maybe) | 4 (maybe) | about half are correct fail-closed checks: hint only |
| Commented-out code | 0 | 2 blocks + 1 line | all real, after requiring it to parse as code |
| Unused parameters | 1 | 0 | real; LangGraph/Gradio false alarms gone |
| Deep nesting (5+) | 3 | 4 | real (processEnrollment: 6 levels, CCN 81) |
| Comments that repeat the code | 30 | 12 | ~9 of 12 real |

What made the difference:
- **Parse to confirm commented-out code.** "html=True enables serving index.html" looks
  like code but doesn't parse.
- **Who calls a function decides if its params can go.** A function passed as a value
  (route handler, LangGraph node, Gradio callback) has a fixed signature.
- **A reason in a comment counts; "/* ignore */" doesn't.**
- **Browser vs server.** An error only logged in the browser is one the user never sees.

## Cross-stack check v1 results (Oct 2026)

Reads Express (routers, `app.use` mounts across files, `router.route()`), Next.js route
files, FastAPI (`APIRouter(prefix=)`, `include_router`) and Flask (blueprints). Calls:
fetch, axios, EventSource, `xhr.open`, your own fetch wrappers, inline `fetch` in HTML,
and `<form action>`. URLs built from constants in the same file are worked out
(`${API}/${id}` with `const API = "/api/clients"`).

| Repo | Calls / routes | Found | Checked by hand |
|---|---|---|---|
| Escrows-AI | 114 / 95 | 5 routes nothing calls | 5 of 5 real (`/api/billing/plans`, `/sequences/blocks`...) |
| Travscape, BlogManager | 2 / 3, 2 / 4 | nothing | right |
| Blind: proshop_mern, mern-skeleton, mern-mediastream, MERN-Template | 23/24, 7/7, 14/15, 3/4 | nothing (after 2 fixes) | right |
| proshop with 2 routes renamed on purpose | | 1 of 2 caught, with the right "did you mean" | see gaps |

What made the difference:
- **A literal segment beats a parameter.** `POST /api/users/${id}` was "reaching"
  `POST /api/users/export`, which hid a dead route and a wrong-method call.
- **Unknown base URL? Match the end only.** `${BASE}/users` can still be checked.
- **LAN dev servers are local.** A blind repo called `http://172.24.147.103:1337/auth/...`.
- **URLs in JSX count as uses** (`<ReactPlayer url={"/api/media/video/" + id}>`), but never
  as calls: `/dashboard` in a link may be a frontend page.

Known gaps:
- A renamed literal route behind a parameter route isn't caught: Express itself sends
  `/api/products/top` to `/:id`, so the call still "reaches" a route.
- Routes called from outside the repo (mobile apps, webhooks) look unused. Names like
  webhook/callback/health are skipped; other routes are only "likely" when the frontend
  uses other routes from the same file.
- Base URLs from another file (an axios instance with `baseURL` in `api.js`) aren't followed;
  those calls are matched on the end of the path.

Dogfooding: the self-scan flagged the route reader's second copy of the Python import
walk (fixed by recording bindings in the import reader), a 5-level function and two
5-parameter functions. It also flagged two comments that showed example code
(`// xhr.open("POST", url)`) as commented-out code: a false alarm worth remembering.

## Hotspots v1 results (Oct 2026)

Changes per file (git log, merges left out) × total indentation in the file's own indent
step. Text inside multi-line strings doesn't count: Travscape's `prompts.py` ranked #1 on
prompt text alone, and dropped out once strings were skipped.

- Escrows-AI (47 commits): #1 `InboxPage.tsx` (12 changes, 2,149 lines, 19 findings),
  #2 `InventoryPage.tsx` (7, 1,123, 12). Same #1 as the baseline hand check.
- Travscape (22 commits): `agents/utils.py`, then `agents/orchestrator.py`.
- Attentry itself: `src/cli/run.ts` was #2, because every new check changed it. Split into
  running the checks and printing them; now #6.

The ranking is relative, so every repo has a #1. It says where to start, not that a file
is bad. Under 10 commits, it's skipped.

## More frameworks, on a public test set (Oct 2026)

So the rules don't only fit our own repos, each framework is checked on public repos:
RealWorld (one API spec, many implementations), framework examples and templates.
Two "full-stack" test repos join the React RealWorld frontend with a backend written to the
same spec, so any mismatch is either real or an Attentry bug.

| Repo | Calls / routes | Found | Checked by hand |
|---|---|---|---|
| RealWorld React + NestJS | 22 / 21 | 2 routes nothing calls | real (`DELETE /api/users/:slug`, `GET /api`) |
| RealWorld React + Django/DRF | 22 / 12 | nothing | right |
| FastAPI full-stack template (generated client) | 23 / 23 | nothing | right |
| Koa examples | 25 / 5 | 1 hint | the app handles it in middleware: right to be a hint |
| Hono, Fastify, NestJS, Django alone; Ignite (React Native) | | not checked: no frontend or no backend | right |

Bugs this found in Attentry:
- Paths without a leading slash (NestJS "api", Django "articles/") were dropped.
- Koa chains (`router.get("/a").post("/b")`) all got the first path.
- `prefix=settings.API_V1_STR` counted as no prefix. Unknown prefixes now stay unknown.
- `include("app.urls")` picked the DRF router instead of `urlpatterns`.
- supertest calls in `test.js` were reported as broken calls. Tests now never count as
  broken calls, and a file named `test.js` counts as a test.
- `…/uppercase` "matched" `GET /post/:id` only through the parameter. A wrong-method
  report now needs a real word in common.

## Astro (Oct 2026)

No Astro grammar is installed, so an .astro file is read as TypeScript: frontmatter and JS
`<script>` blocks as written, the template blanked out line for line. Names the template
uses (`{formatDate(x)}`, `<Card />`) are added after the last line so they count as uses.

- AgentinFlow: 19 of 19 code files read (was 3 of 19). Clean, matching the earlier hand check.
  Two adapter bugs found on it first: an apostrophe in a template comment ("form's") was read
  as a string start and hid `bySide(...)`, and a self-closing JSON-LD `<script />` was read
  as the start of code.
- Astro Paper: 54 files, clean, after fixing `typescript` being reported as an unused
  package (it's used by `astro check` and the editor, never imported).

## Findings an agent can act on (Oct 2026)

"slab: 6 parameters. Pass an object" left an agent to find the parameters and callers itself,
and "Clean these first" for hotspots could send it off rewriting a working file. Every finding
now has: what (with evidence: parameter names, every caller, every copy and how it differs),
why it matters, fix steps, safe / ask first / warning, and how to check the fix. `--agent`
prints them grouped by rule, so the guidance is said once (fewer tokens for the agent).
Hotspots became a warning: test what you change first, keep cleanup in its own commit.

## Database checks v1, from SQL Antipatterns (Oct 2026)

Lessons from Karwin that decided what to build:
- **Rounding Errors (ch. 10):** "Virtually any use of FLOAT is suspect", but floats are right
  for scientific values. So only money-named fields count (price, amount, fee...), never
  ratings, scores or coordinates, and not priceCents or taxRate.
- **Index Shotgun (ch. 13):** "Know your data, know your queries, MENTOR your indexes". Index
  advice needs measurements Attentry doesn't have, so it never tells an agent to add an index.
  That's how Index Shotgun happens.
- **Naive Trees (ch. 3):** a parent pointer is fine for shallow trees ("Don't over-engineer").
  Walking a tree one query per level is a hint, fixed with one recursive query
  (WITH RECURSIVE, $graphLookup) before any schema change.
- **Random Selection, Poor Man's Search Engine, Implicit Columns (ch. 16, 17, 19):** all have
  legitimate uses (small tables, rare queries, ad hoc SQL), so they're hints. Except INSERT
  without a column list, which breaks when the table changes.
- Passwords and SQL injection (ch. 20, 21) belong to the security checks.

Not in the book, but the most common database mistake in AI code: queries inside loops (N+1).

| Repo | Found | Checked by hand |
|---|---|---|
| Escrows-AI (Mongoose) | 12 N+1, 4 tree walks, 2 money fields, 19 $regex searches | N+1: 11 real + 1 parallel (hint). Tree walks: real, shallow. Money: `budget` (whole dollars) and `cost` (credits) are borderline: right to be hints |
| proshop (Mongoose) | 5 money fields, 1 $regex search | real: prices with 15% tax computed on them |
| FastAPI template, Django and NestJS RealWorld, MERN repos | nothing | right |
| AgentinFlow, Attentry | "not checked": no database | right |

False alarms found and fixed on the way: `TOKEN_RE.exec()` and `Object.create()` read as model
queries; `totalUsed` read as money; a seed script inserting row by row; tests holding example
SQL; and "no database issues" printed for repos with no database at all.

## Security and crash checks v1 (Oct 2026)

What AI-built apps get wrong, from 2025-2026 scans and incidents:
- **Broken access control is the #1 critical class.** CSO Online's test of 15 agent-built apps
  found 69 vulnerabilities, mostly API authorization and business logic (no exploitable SQL
  injection or XSS). Escape scanned 5,600+ vibe-coded apps: 2,000+ vulnerabilities, most
  reachable without logging in, 400+ exposed secrets, 175 PII exposures.
- **Incidents:** Lovable (CVE-2025-48757: missing Supabase row-level security, 303 endpoints in
  170 apps; an app with an inverted auth guard exposed 18K users); Moltbook (a Supabase key in
  frontend JS with no RLS gave full database access; sign-up had no rate limit).
- **Numbers:** Veracode: 45% of AI code samples failed OWASP Top 10 tests, 86% on XSS-prone
  tasks. Hardcoded secrets in 72% of 38,630 AI Android apps (Cybernews).
- **Crashes:** error handling that assumes the happy path, missing edge cases, data-shape
  mismatches, assumed environment variables.

Lessons from the books:
- **Alice & Bob (ch. 4):** validate on the server; parameterized queries; encode output;
  allowlist redirects; one global error handler; never show stack traces or DB errors; fail
  closed. **Ch. 5:** SSRF (allowlist outbound URLs), CSRF.
- **SQL Antipatterns ch. 21:** SQL injection has no legitimate use, and "check the back seat":
  values from your own database can carry it too. **Ch. 20:** a password the app can read back
  is the antipattern (unless it's a credential the app uses to call another service).

Design: the endpoint checks use the route map from the cross-stack check. Each route knows its
guards: middleware on the route, on every mount above it, `use()` before it (in order),
NestJS guards / forRoutes / global guards, Fastify hooks and autohooks, FastAPI dependencies,
Flask/Django decorators, DRF permission classes. Checks inside the handler (`jwt.verify`,
`getServerSession`) count. User input is followed through variables in the same function,
but not through calls: a database record isn't user input.

| Repo | Found | Checked by hand |
|---|---|---|
| Escrows-AI | nothing | right: auth middleware on every data route, inline token checks on /me, ownership in every query, rate limits on login |
| proshop | upload route with no auth; 2 order IDORs (any user reads / marks paid any order); no login rate limit; hints: localStorage JSON.parse | all real (known issues of this tutorial app) |
| NestJS RealWorld | unauthenticated `DELETE /api/users/:slug`; 3 article IDORs (edit/delete anyone's article or comment); prisma/.env committed | all real |
| mern-skeleton/mediastream | public user list; JWT secret fallback; `new User(req.body)`; Math.random salt | real |
| Django RealWorld | DEBUG = True in settings | real |
| BlogManager | CORS * with credentials; predictable session ids; no auth (hint) | real |
| Travscape | 7 innerHTML with data (chat titles are user text) | real |
| FastAPI template | .env committed (template placeholders) | real pattern |
| Hono examples | open writes in an app where only /auth/* is guarded | consistent with the code (an example) |

False alarms found and fixed on the way (26 Hono/Koa async-handler alarms; then 1-2 each):
async handlers flagged outside Express 4 (Koa, Hono and Express 5 catch them); POST /users
(sign-up) as unauthenticated; admin-guarded routes as IDORs; FastAPI `get_current_active_superuser`
and Fastify autohooks not read as auth; @fastify/autoload files reported unused (15) and
dropped with their hooks; hCaptcha site keys and Firebase web keys as secrets; `sse.send(e)` as
an error leak; a DB record's path as user input; SSRF on URLs with a fixed host; one app's auth
applied to another app in the same repo; upload temp paths as user paths.

Known gaps: Supabase/Firebase row-level security rules aren't read (they live in the database
or console, not the repo); NoSQL injection is only flagged for whole-body filters, not single
fields; ownership checks done in a service layer called from the handler aren't followed.

## In the editor, without annoying people or costing agents (Oct 2026)

What forums and studies say, and what Attentry does about it:

- **Trust dies with false alarms.** Google keeps a check only if under 10% of its findings get
  "not useful"; above that it's turned off until fixed. When tools report a lot, little gets fixed
  (16% of 9,473 FindBugs warnings in one Google fixit). Attentry: a "not useful" button; a rule
  over 10% (and at least 2 clicks) becomes a hint for the repo.
- **Showing everything buries people.** Snyk's answer is "delta findings": only what your change
  added. Attentry: "your changes" is the default in the editor, and `scan --changed` in the CLI.
- **Agents drown in lint output.** In Cursor, a lint-heavy project filled the agent's context,
  the agent re-read it in a loop, and 5% of an Ultra plan went in minutes; `read_lints` still
  has no cap (Oct 2026). Agents also loop "fixing" lints and undoing their own fix. Attentry: at
  most 20 squiggles per file, your changes only, one-line messages, and `--brief` caps an agent
  at 10 lines.
- **Severity decides what agents read.** Cursor's agent reads only Error and Warning diagnostics,
  for open files. Attentry: security and crashes are errors, things that will break are warnings,
  clean-up is info, so people see it and no credits go to it.
- **Hooks should be silent when clean.** Claude Code shows a hook's stderr to Claude only on
  exit 2, and caps hook output at 10,000 characters. For the coming hooks: print nothing when an
  edit added nothing, and a few short lines when it did.

Plain words are built from the syntax tree (what a function checks, calls, changes and
returns), plus a "likely replacement" for unused code: a used function that touches the same
fields and calls. No AI. It's only as clear as the code's names, and it can't know purpose.

On Escrows-AI the whole repo's findings in `--brief` form are 1,120 characters (about 280
tokens) against 26,800 for `--agent`.

Found by dogfooding: Attentry flagged its own extension's `activate`/`deactivate` as dead (VS
Code calls them by name), and "route nothing calls" was a warning though it breaks nothing.

Not verified yet: the extension inside a real VS Code (the workspace can't download VS Code);
the server was tested end to end over stdio, from source and as bundled.

Sources: [Google, CACM 2018](https://cacm.acm.org/magazines/2018/4/226371-lessons-from-building-static-analysis-tools-at-google/pdf),
[Snyk delta findings](https://snyk.io/fr/blog/unburdening-developers-from-vulnerability-fatigue-with-snyk-delta-findings/),
[Cursor: large lint output](https://forum.cursor.com/t/large-lint-output-causes-repeated-context-summarization/164399),
[Cursor: LSP diagnostics the agent reads](https://forum.cursor.com/t/does-agents-iterate-on-lint-errors-work-with-custom-third-party-lsp-servers-or-only-built-in-linters/168705),
[Cursor: lint loop](https://forum.cursor.com/t/unrestricted-loop-of-linter-errors/36436),
[Claude Code hooks](https://code.claude.com/docs/en/hooks),
[MCP token bloat](https://thenewstack.io/how-to-reduce-mcp-token-bloat/).

## Hooks, the background Attentry and speed (Oct 2026)

- **Speed.** 95% of a scan was per-file work, and most of that was walking syntax trees: every
  rule walked every tree on its own, recursing through the parser's WASM memory. One cursor walk
  per tree, shared, cut Escrows-AI from 8.7s to 4.9s. Keeping each file's results in memory and
  rereading only changed files brings a re-check after an edit to ~0.5s in-process; through the
  built hook it answers in ~120ms. Findings stayed identical on five repos (compared line by line).
- **No disk cache.** Options weighed: a cache in the repo (can be committed, or shipped poisoned
  in a clone), a signed cache in the user's folder (work), or memory only. Chose memory only, in a
  background Attentry per repo: the first scan of a session is the only slow one.
- **The ledger.** "New" means new since the agent's session started (or before its first edit),
  matched by rule, file and title, so moved lines don't count as new and a function made dead by
  an edit elsewhere does.
- **Found while building.** `node --import tsx` resolves `tsx` from the current folder, and hooks
  run from the project's folder: hooks now run a built single file with plain `node`.
- **Real run.** Claude Code 2.1.312, asked to add an `eval()` route: after the edit it got
  "index.js:14 error attentry/code-eval: eval() runs code from req.body" and passed it on.

## Reuse before writing (Oct 2026)

Before each agent edit, the functions it adds are compared with the repo by the same copy
finder as `attentry scan`. Tested by treating every function in five repos as if it were being
written now, and reading every match:

| Repo | Functions | Notes, first try | Notes, final |
|---|---|---|---|
| Escrows-AI | 703 | 66 | 38 |
| FastAPI template | 429 | 15 | 2 |
| React RealWorld | 162 | 7 | 0 |
| ignite | 405 | 16 | 4 |
| Travscape | 64 | 19 | 9 |

Kept (real): escapeRegex in 6 files, timeAgo in 4, getUserPlan, planFromProductId /
planFromPriceId, connectGmail and connectWhatsApp written twice, Travscape's second
orchestrator, Python `_strip_json_state` vs JS `stripJsonState`, ignite's openLinkInBrowser
redefined in a screen.

Dropped (false alarms) and why:
- A helper written inside the function being edited shares its code (createAdminAuth/adminAuth).
- Callbacks in objects and class methods are wiring, not something to import (onSettled,
  beforeLoad, componentWillMount, Redux props).
- Event handlers, framework hooks and conventions share names on purpose (handleSubmit,
  mapStateToProps); one-word names are too common.
- Several names shared with one other file is an interface (dodo.js and stripe.js both have
  isConfigured, createCheckout, parseWebhook).
- Another app in the repo can't be imported (a frontend page vs an email template package).
- deleteUser (a function) vs DeleteUser (a component); generated API clients (`.gen.ts`).
- Tiny generic functions match by being generic (ignite's `$heading` style objects): small copies
  count only with distinctive text in them.

Also fixed: "used in N places" counted import lines as uses.

Real run: Claude Code, asked to write `commentAge` without reading other files, got "`timeAgo` in
src/utils/time.js:1 has the same steps and the same text ("just now", "m ago", "h ago")", read it,
and replaced its copy with a call to `timeAgo`.
