# Regression repos

Made-up code that recreates what hand checks of real AI-built repos found: each false alarm
Attentry raised there, and each real problem it should keep finding. `<name>.expected.json` lists
every finding Attentry must report in `repos/<name>`, no more and no less
(see tests/regressions.test.ts).

The labels sit outside the repos they describe: a label naming `RoomList.tsx` would count as
using it.
