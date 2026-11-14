# Roadmap

What's next for Attentry, most important first. Each item says what goes wrong today, and what
changes.

## 0.1.5

### 1. Never "no problems" for code Attentry didn't read

**Today:** when an agent asks the `check` tool about specific files, Attentry filters its findings
by those paths and never checks whether it read them. Files outside the project, files that don't
exist, and files in a language it doesn't read all come back as "No problems in 3 files". Found
when Claude built a game in a sibling folder: Attentry answered "no problems" for the game's files,
and for `does/not/exist.ts`.

**Change:** `check` says which named files it checked, and which it didn't and why: outside the
project (with the project's name and how to check the other folder), not found, or not a language
it reads. "No problems" only ever covers files it read. Tests cover each case.

### 2. Tell the agent when it edits outside the project

**Today:** an edit to a file outside the project Attentry reads is skipped without a word. The
agent keeps working, and everyone assumes Attentry is checking it.

**Change:** the first such edit in a session gets one note: Attentry reads this project, and edits
in that folder aren't checked. Then the agent can tell the person.

### 3. Choose the project in the panel

**Today:** when the opened folder isn't a project itself, Attentry looks one level down and picks
one project (the only git checkout, or the only folder that looks like a project). Other projects
in the folder are skipped silently, and the choice is made once, when the editor starts, so a repo
cloned while the editor is open isn't noticed until a reload.

**Change:** when the opened folder holds more than one project, the panel shows which one is
checked, with a menu of the others. The choice is remembered for that folder, and the editor's
checks, the agent's hooks and its tools all follow it. Without a choice, the panel still says how
many projects it found and which one it checks. The project is picked again when folders change.

## Later

### Block mode for Codex

Test whether Codex follows Attentry's "not done yet" and "use the existing function" answers in
block mode. If it does, block mode works for Codex and the README says so; if not, the panel doesn't
offer Block for Codex.

### The background Attentry doesn't hold the extension's folder

The background process runs from Attentry's own folder, so on Windows the folder can't be replaced
while it runs. That hung a reinstall of the same version during testing (an update to a new version
installs into a new folder, so users don't hit it). Run it from a neutral folder instead.
