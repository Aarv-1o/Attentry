# Roadmap

What's next for Attentry, in two releases. Each item says what goes wrong today, and what changes.
(The stores only take three-part versions, so the second release is 0.1.6, not 0.1.5.1.)

## 0.1.5: trust what Attentry tells you

Fixes about the same thing: when Attentry says something, it should be true, and when it isn't
working, the panel says so and how to fix it. Shipped first because a checker that says "fine"
about code it never read is worse than no checker.

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

### 3. Is Claude Code actually running Attentry?

**Today:** the panel's "Connected" for Claude Code means the plugin is installed and on. It doesn't
mean Claude Code runs its hooks: they can be installed and still not run (raised on Reddit after the
launch). Codex already has a check for this.

**Change:** Attentry notes when Claude Code last ran one of its hooks, as it does for Codex. If a
Claude Code session ran since connecting and Attentry never heard from it, the panel says so and
what to do, instead of a green dot that may not be true. `attentry doctor` says the same.

### 4. The background Attentry doesn't hold the extension's folder

**Today:** the background process runs from Attentry's own folder, so on Windows the folder can't be
replaced while it runs. That hung a reinstall of the same version during testing (an update to a
new version installs into a new folder, so users don't hit it).

**Change:** it runs from a neutral folder.

### 5. Check setup from the panel

**Today:** the change card and the doctor tell people to run `attentry init` or `attentry doctor`,
but someone using the extension has no `attentry` command: it only exists for people running
Attentry from its source.

**Change:** a **Check setup** button in the panel runs the doctor and shows its results, with the
fix for each line where the panel can do it (Connect, Allow tests). The messages stop pointing at a
command the person doesn't have. This is where #3's "Claude Code never ran Attentry" shows up too.

## 0.1.6: several projects and editors

How Attentry finds what to check, and which Attentry runs.

### 6. Choose the project in the panel

**Today:** when the opened folder isn't a project itself, Attentry looks one level down and picks
one project (the only git checkout, or the only folder that looks like a project). Other projects
in the folder are skipped silently, and the choice is made once, when the editor starts, so a repo
cloned while the editor is open isn't noticed until a reload.

**Change:** when the opened folder holds more than one project, the panel shows which one is
checked, with a menu of the others. The choice is remembered for that folder, and the editor's
checks, the agent's hooks and its tools all follow it. Without a choice, the panel still says how
many projects it found and which one it checks. The project is picked again when folders change.

### 7. VS Code and Cursor with different versions of Attentry

**Today:** Codex runs the Attentry named in `~/.attentry/build.json`, which each editor rewrites
when it starts. With VS Code and Cursor both installed on different Attentry versions, Codex runs
whichever editor's opened last, which may be the older one.

**Change:** each editor writes its version next to the path, and only replaces the entry with a
newer version (or when the named Attentry is gone). Codex always runs the newest Attentry installed.

## Later

### Block mode for Codex

Test whether Codex follows Attentry's "not done yet" and "use the existing function" answers in
block mode. If it does, block mode works for Codex and the README says so; if not, the panel doesn't
offer Block for Codex.
