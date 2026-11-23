# src/testing

What tests a change needs and which routes the tests cover. Reads the index and the plan;
never runs the app. Running the project's test command stays in `src/agent/tests.ts`.

- `coverage.ts`: which routes the tests reach. The requests each test file sends come from
  `src/languages/jsTestCalls.ts` and `pythonTestCalls.ts`.

Planned (see docs/tests-plan.md): `select.ts` (tests for one source file), `suggest.ts` (tests
a plan needs), `steps.ts` (plan steps and when the edits move on).
