# src/safety

Not built yet. The planned safety layer (see SPEC.md, "Safety rules"): a git checkpoint before
Detron's agent makes a fix, the tests and type check after it, and an automatic undo when they
fail.

Running the tests is built already, for evidence rather than undo: `src/agent/tests.ts` runs
them at check-ins and at the end of a task, and the change card shows the result.
