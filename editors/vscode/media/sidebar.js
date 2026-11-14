// The panel's page: draws what it's sent (status, findings, agent) and sends back what's clicked.
// Three parts, top to bottom: the findings, the agents (Claude Code, Codex), and one line on the last check.
const vscode = acquireVsCodeApi();
const app = document.getElementById("app");
const PARTS = [["security", "Security", "error"], ["breaks", "Will break", "warning"], ["database", "Database", "warning"], ["cleanup", "Clean-up", "info"]];
const LIVE_MS = 90_000; // an agent that edited within this is "working now"
let status;
let data;
let agent;
let setup; // Check setup: undefined while closed, null while checking, then the checks
let lastDone; // edits since the check-in at the last draw: the newest tick animates only when it changes
const opened = new Map(); // groups the person opened or closed: kept across refreshes

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Backticks in plain words become code (after escaping, so nothing in them is HTML).
const words = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(time) {
  const m = Math.round((Date.now() - time) / 60_000);
  if (m < 1) return "just now";
  return m < 60 ? relative.format(-m, "minute") : relative.format(-Math.round(m / 60), "hour");
}

// ---- Findings ----

function item(f) {
  const more = [f.does, f.replacedBy].filter(Boolean);
  const i = f.file.lastIndexOf("/");
  return `<div class="row" tabindex="0" data-open="${esc(f.file)}" data-line="${f.line}" title="${esc([f.does, f.replacedBy, f.why].filter(Boolean).join("\n\n").replace(/`/g, ""))}">
    <i class="glyph ${esc(f.severity)}" aria-label="${esc(f.severity)}"></i>
    <span class="title">${esc(f.title)}</span>
    <span class="loc">${esc(f.file.slice(i + 1))}:${f.line}</span>
    ${more.length ? `<span class="does">${more.map(words).join(" ")}</span>` : ""}
    <button class="fix" data-fix="${esc(f.id)}" title="Copy what an agent needs to fix this">Copy fix</button>
  </div>`;
}

// A folder of several projects: which one Attentry checks, and a menu of the others. The agents'
// hooks and tools follow the choice too.
function projectPicker() {
  const projects = data?.projects ?? [];
  if (projects.length < 2) return "";
  const current = data?.project ?? "";
  const choices = [...projects.map((p) => [p, p]), ["", "All of them (the whole folder)"]];
  return `<div class="project"><label for="project">Checking</label><select id="project" data-project>${choices.map(([value, name]) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></div>
    <p class="quiet project-note">${plural(projects.length, "project")} in this folder. Your agent's checks follow this choice.</p>`;
}

function findings() {
  const show = status?.show ?? data?.show ?? "changes";
  const items = data?.items ?? [];
  const hotspots = items.filter((f) => f.rule === "hotspot");
  const of = (part) => items.filter((f) => f.part === part && f.rule !== "hotspot");
  const found = PARTS.filter(([part]) => of(part).length);
  const total = found.reduce((n, [part]) => n + of(part).length, 0);
  // "Your changes" means everything when Attentry can't tell what changed: say so, not "in your changes".
  const where = show === "changes" && !data?.noChanges ? "in your changes" : "in this repo";
  const older = show === "changes" && data?.older ? ` <a data-act="toggleShow">${plural(data.older, "older finding")} →</a>` : "";
  // The headline answers "is anything wrong?"; the groups under it are the details.
  const headline = !data
    ? `<p class="headline quiet">Checking…</p>`
    : total
      ? `<p class="headline"><b>${plural(total, "problem")}</b> ${where}${older}</p>
         <div class="bar" aria-hidden="true">${found.map(([part, , tone]) => `<i class="${tone}" style="flex:${of(part).length}"></i>`).join("")}</div>`
      : `<p class="headline"><i class="glyph ok"></i>No problems ${where}${older}</p>`;
  // The four parts, always: what was checked, and how many of each (a click opens that group).
  const tally = data ? `<div class="tallies">${PARTS.map(([part, name, tone]) => `<button class="tally ${of(part).length ? "" : "zero"}" data-jump="${part}"><i class="glyph ${tone}"></i><b>${of(part).length}</b> ${esc(name)}</button>`).join("")}</div>` : "";
  const groups = found.map(([part, name, tone]) => `<details id="${part}" ${part !== "cleanup" || found.length === 1 ? "open" : ""}><summary><i class="glyph ${tone}"></i>${esc(name)}<span class="n">${of(part).length}</span></summary>${of(part).map(item).join("")}</details>`).join("");
  return `<section class="findings">
    ${projectPicker()}
    <div class="tabs" role="tablist" aria-label="What to show">
      <button role="tab" data-act="toggleShow" aria-selected="${show === "changes"}" ${show === "changes" ? "disabled" : ""}>Your changes</button>
      <button role="tab" data-act="toggleShow" aria-selected="${show === "all"}" ${show === "all" ? "disabled" : ""}>Whole repo</button>
    </div>
    ${headline}
    ${tally}
    ${data?.noChanges && show === "changes" ? `<p class="quiet">Can't tell what changed (${esc(data.noChanges)}), so this is everything.</p>` : ""}
    ${groups}
    ${hotspots.length ? `<details id="hotspots"><summary><i class="glyph hint"></i>Hotspots<span class="n">${hotspots.length}</span></summary><p class="quiet">Files that change often and are complex: change them in small steps and test after each.</p>${hotspots.map((h) => `<div class="row" tabindex="0" data-open="${esc(h.file)}" data-line="1"><i class="glyph hint"></i><span class="title">${esc(h.file)}</span><span class="does">${esc(h.title)}</span></div>`).join("")}</details>` : ""}
  </section>`;
}

// ---- Claude Code ----

// One tick per edit between check-ins: filled ones are edits since the last check-in.
function checkInMeter(live) {
  const { untilCheckIn, checkInEvery } = live;
  const done = checkInEvery - untilCheckIn;
  const fresh = lastDone !== undefined && done !== lastDone;
  lastDone = done;
  const ticks = Array.from({ length: checkInEvery }, (_, i) => `<i class="${i < done ? "on" : ""}${i === done - 1 && fresh ? " new" : ""}"></i>`).join("");
  return `<div class="meter" role="img" aria-label="${done} of ${checkInEvery} edits until the agent's next check-in">
    <p>Next check-in in <b>${plural(untilCheckIn, "edit")}</b></p><div class="ticks" style="grid-template-columns:repeat(${checkInEvery},1fr)">${ticks}</div></div>`;
}

function task(live, working) {
  const tone = { passed: "ok", failed: "error", timeout: "error", running: "busy" }[live.tests?.state] ?? "hint";
  // Found but not allowed: a repo's test command could run anything, so the person says yes here.
  const allow = live.tests?.state === "blocked" ? ` <a data-act="allowTests">Allow tests</a>` : "";
  const tests = live.tests ? `<p class="tests ${esc(live.tests.state)}"><i class="glyph ${tone}"></i>Tests: ${esc(live.tests.text)}${allow}</p>` : "";
  return `<p class="task">${working ? "This task" : "Last task"}: ${plural(live.edits, "edit")} to ${plural(live.files ?? 0, "file")}, ${live.added ? `<b>${plural(live.added, "problem")} added</b>` : "no problems added"}${working ? "" : `, ${ago(live.lastEditAt)}`}.</p>${tests}`;
}

const MODES = {
  suggest: "Attentry tells the agent about problems, and never stops it.",
  block: "The agent can't finish a task while it has added security or crash problems.",
};

const head = (name, tone, text) => `<div class="who"><h2>${name}</h2><span class="pill ${tone}"><i></i>${text}</span></div>`;

function modeTabs() {
  const mode = agent.mode === "block" ? "block" : "suggest";
  return `<div class="mode">
      <div class="tabs" role="tablist" aria-label="How strict">
        <button role="tab" data-mode="suggest" aria-selected="${mode === "suggest"}" ${mode === "suggest" ? "disabled" : ""}>Suggest</button>
        <button role="tab" data-mode="block" aria-selected="${mode === "block"}" ${mode === "block" ? "disabled" : ""}>Block</button>
      </div>
      <span class="quiet">${MODES[mode]}</span>
    </div>`;
}

const working = (live) => Date.now() - live.lastEditAt < LIVE_MS;
const liveTask = (live) => (live.edits ? task(live, working(live)) : "") + checkInMeter(live);

// [pill tone, pill text, note, button] for each state but connected.
const CLAUDE = {
  missing: ["off", "Not connected", "Connect adds Attentry to Claude Code, for all your projects. Then Attentry tells Claude about problems after each edit, and Claude can ask Attentry before it writes code (read-only, so Claude Code won't ask you each time).", "Connect Claude Code"],
  stale: ["warn", "Needs reconnecting", "It runs an old copy of Attentry from before the extension updated.", "Reconnect Claude Code"],
  unheard: ["warn", "Not running", "Claude Code ran here since connecting, but never ran Attentry's hooks. Start a new Claude Code session (one open since before connecting doesn't have them). If this stays, run `/hooks` in Claude Code to see whether Attentry's are listed, and check that `node` runs in a terminal.", "Reconnect Claude Code"],
};

function claudeSection(state, busy, extras) {
  if (state === "connected") return `<section class="agent">${head("Claude Code", busy ? "live" : "ok", busy ? "Working now" : "Connected")}${extras}</section>`;
  const [tone, text, note, button] = CLAUDE[state] ?? CLAUDE.missing;
  return `<section class="agent">${head("Claude Code", tone, text)}
      <p class="quiet">${words(note)}</p>
      <button class="primary" data-act="connectAgent">${button}</button>
    </section>`;
}

// Codex runs a plugin's hooks only once the person trusts them: each state says what's next.
// [pill tone, pill text, note, button]
const CODEX = {
  missing: ["off", "Not connected", "Connect adds Attentry to Codex, for all your projects. Codex then asks you once to trust Attentry's hooks.", "Connect Codex"],
  off: ["warn", "Turned off", "The Attentry plugin is in Codex, but turned off.", "Turn it on"],
  waiting: ["ok", "Connected", "Start a new Codex session. Codex asks you once to trust Attentry's hooks: say yes (or run `/hooks`)."],
  approve: ["warn", "Needs your OK", "Codex hasn't run Attentry's hooks yet. In Codex, run `/hooks`, trust Attentry's, then start a new session."],
  running: ["ok", "Connected"],
};

function codexSection(state, busy, extras) {
  const [tone, text, note, button] = CODEX[state] ?? CODEX.missing;
  const [pillTone, pillText] = busy && state === "running" ? ["live", "Working now"] : [tone, text];
  return `<section class="agent">${head("Codex", pillTone, pillText)}
      ${note ? `<p class="quiet">${words(note)}</p>` : ""}
      ${button ? `<button class="primary" data-act="connectCodex">${esc(button)}</button>` : ""}
      ${extras}
    </section>`;
}

// Claude Code, and Codex for someone who uses it. Suggest or block is one setting for both, under
// the first agent that's connected; the task under the agent doing it.
function agents() {
  if (!agent) return `<section class="agent"><div class="who"><h2>Claude Code</h2></div></section>`;
  const claude = agent.claude ?? agent.hooks;
  const codex = agent.codex ?? "absent";
  const on = { claude: claude === "connected", codex: ["running", "waiting", "approve"].includes(codex) };
  const modeAt = on.claude ? "claude" : on.codex ? "codex" : undefined;
  const live = agent.live;
  const owner = live?.agent ?? "claude";
  const liveAt = live && (on[owner] ? owner : modeAt);
  const extras = (name) => (modeAt === name ? modeTabs() : "") + (liveAt === name ? liveTask(live) : "");
  const busy = (name) => !!live && owner === name && working(live);
  return claudeSection(claude, busy("claude"), extras("claude")) + (codex === "absent" ? "" : codexSection(codex, busy("codex"), extras("codex")));
}

// ---- Check setup ----

// The doctor's checks, each with its fix: a button where the panel can do it, else what to do.
const MARK = { true: ["ok", "✓"], warn: ["warn", "!"], false: ["bad", "✗"] };
const ACTIONS = { connectAgent: "Connect Claude Code", connectCodex: "Connect Codex", allowTests: "Allow tests" };
function setupSection() {
  if (setup === undefined) return "";
  const line = (c) => {
    const [tone, mark] = MARK[String(c.ok)];
    const fix = c.action ? `<button class="primary" data-act="${c.action}">${ACTIONS[c.action]}</button>` : c.fix ? `<p class="quiet">${words(c.fix)}</p>` : "";
    return `<li class="${tone}"><span class="mark">${mark}</span><div><p>${words(c.text)}</p>${fix}</div></li>`;
  };
  const body = setup === null ? `<p class="quiet">Checking…</p>` : `<ul class="checks">${setup.map(line).join("")}</ul>`;
  return `<section class="setup"><div class="who"><h2>Setup</h2><a data-act="closeSetup">Close</a></div>${body}</section>`;
}

// ---- The last check ----

function footer() {
  const busy = !status || status.scanning;
  const line = status?.error
    ? `<span class="bad">Check failed: ${esc(status.error)}</span>`
    : status?.reading ? `Reading the repo: ${esc(status.reading)}`
    : busy ? "Checking…"
    : `Up to date · checked ${status.lastScanAt ? ago(status.lastScanAt) : "just now"}${status.autoScan === false ? " · automatic checks off" : ""}`;
  // The project, when it's a folder inside the one the editor opened.
  const project = data?.project ? `${esc(data.project)} · ` : "";
  return `<footer class="${busy ? "busy" : ""}"><i class="glyph ${status?.error ? "error" : busy ? "busy" : "ok"}"></i><span>${project}${line}</span><a data-act="checkSetup" title="Is Attentry set up here, and working?">Check setup</a><a data-act="settings" title="Hints, automatic checks">Settings</a></footer>`;
}

// Attentry's site, passing it on, and the code.
const links = () => `<nav class="links" aria-label="Attentry">
  <button data-act="openSite">View the site</button>
  <button data-act="share">Share with a friend</button>
  <button data-act="openGithub">GitHub</button>
</nav>`;

function render() {
  const scroll = window.scrollY;
  // attentry-ignore xss: every value is escaped by esc() or words() above, and the panel's CSP runs only Attentry's own script
  app.innerHTML = findings() + agents() + setupSection() + footer() + links();
  for (const [id, open] of opened) {
    const group = document.getElementById(id);
    if (group) group.open = open;
  }
  window.scrollTo(0, scroll);
}
document.addEventListener("toggle", (e) => {
  if (e.target.id) opened.set(e.target.id, e.target.open);
}, true);

document.addEventListener("click", (e) => {
  const fix = e.target.closest("[data-fix]");
  if (fix) return vscode.postMessage({ type: "copyFix", id: fix.dataset.fix });
  const mode = e.target.closest("[data-mode]");
  if (mode) return vscode.postMessage({ type: "setMode", mode: mode.dataset.mode });
  const jump = e.target.closest("[data-jump]");
  if (jump) {
    const group = document.getElementById(jump.dataset.jump);
    if (group) (group.open = true), group.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const act = e.target.closest("[data-act]");
  if (act?.dataset.act === "closeSetup") (setup = undefined), render();
  if (act) return vscode.postMessage({ type: act.dataset.act });
  const open = e.target.closest("[data-open]");
  // Findings' paths are the project's: inside the opened folder when the project is a folder in it.
  if (open) vscode.postMessage({ type: "open", file: data?.project ? `${data.project}/${open.dataset.open}` : open.dataset.open, line: Number(open.dataset.line) });
});
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-project]")) vscode.postMessage({ type: "chooseProject", project: e.target.value });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches(".row")) e.target.click();
});
window.addEventListener("message", ({ data: m }) => {
  if (m.type === "status") status = m.status;
  if (m.type === "findings") data = m.data;
  if (m.type === "agent") agent = m.info;
  if (m.type === "setup") setup = m.checks;
  render();
});
render();
vscode.postMessage({ type: "ready" });
