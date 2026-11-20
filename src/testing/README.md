# src/testing

What tests a change needs and which routes the tests cover. Reads the index and the plan;
never runs the app. Running the project's test command stays in `src/agent/tests.ts`.

Planned files (see docs/tests-plan.md): `coverage.ts` (routes each test file calls),
`select.ts` (tests for one source file), `suggest.ts` (tests a plan needs), `steps.ts`
(plan steps and when the edits move on).
