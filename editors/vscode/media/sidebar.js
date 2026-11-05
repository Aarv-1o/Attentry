// The panel's page: draws what it's sent (status, findings, agent) and sends back what's clicked.
// Three parts, top to bottom: the findings, Claude Code, and one line on the last check.
const vscode = acquireVsCodeApi();
const app = document.getElementById("app");
const PARTS = [["security", "Security", "error"], ["breaks", "Will break", "warning"], ["database", "Database", "warning"], ["cleanup", "Clean-up", "info"]];
const LIVE_MS = 90_000; // an agent that edited within this is "working now"
let status;
let data;
let agent;
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
  const groups = found.map(([part, name, tone]) => `<details id="${part}" ${part !== "cleanup" || found.length === 1 ? "open" : ""}><summary><i class="glyph ${tone}"></i>${esc(name)}<span class="n">${of(part).length}</span></summary>${of(part).map(item).join("")}</details>`).join("");
  return `<section class="findings">
    <div class="tabs" role="tablist" aria-label="What to show">
      <button role="tab" data-act="toggleShow" aria-selected="${show === "changes"}" ${show === "changes" ? "disabled" : ""}>Your changes</button>
      <button role="tab" data-act="toggleShow" aria-selected="${show === "all"}" ${show === "all" ? "disabled" : ""}>Whole repo</button>
    </div>
    ${headline}
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
  const tests = live.tests ? `<p class="tests ${esc(live.tests.state)}"><i class="glyph ${tone}"></i>Tests: ${esc(live.tests.text)}</p>` : "";
  return `<p class="task">${working ? "This task" : "Last task"}: ${plural(live.edits, "edit")} to ${plural(live.files ?? 0, "file")}, ${live.added ? `<b>${plural(live.added, "problem")} added</b>` : "no problems added"}${working ? "" : `, ${ago(live.lastEditAt)}`}.</p>${tests}`;
}

const MODES = {
  suggest: "Attentry tells Claude about problems, and never stops it.",
  block: "Claude can't finish a task while it has added security or crash problems.",
};

function claudeCode() {
  if (!agent) return `<section class="agent"><div class="who"><h2>Claude Code</h2></div></section>`;
  const state = agent.claude ?? agent.hooks;
  const live = agent.live;
  const working = live && Date.now() - live.lastEditAt < LIVE_MS;
  const [tone, text] = state === "connected" ? (working ? ["live", "Working now"] : ["ok", "Connected"]) : state === "stale" ? ["warn", "Needs reconnecting"] : ["off", "Not connected"];
  const head = `<div class="who"><h2>Claude Code</h2><span class="pill ${tone}"><i></i>${text}</span></div>`;
  if (state !== "connected") {
    return `<section class="agent">${head}
      <p class="quiet">${state === "stale" ? "It runs an old copy of Attentry from before the extension updated." : "Connect it, and Attentry tells Claude about problems right after each edit."}</p>
      <button class="primary" data-act="connectAgent">${state === "stale" ? "Reconnect Claude Code" : "Connect Claude Code"}</button>
    </section>`;
  }
  const mode = agent.mode === "block" ? "block" : "suggest";
  return `<section class="agent">${head}
    <div class="mode">
      <div class="tabs" role="tablist" aria-label="How strict">
        <button role="tab" data-mode="suggest" aria-selected="${mode === "suggest"}" ${mode === "suggest" ? "disabled" : ""}>Suggest</button>
        <button role="tab" data-mode="block" aria-selected="${mode === "block"}" ${mode === "block" ? "disabled" : ""}>Block</button>
      </div>
      <span class="quiet">${MODES[mode]}</span>
    </div>
    ${live ? task(live, working) + checkInMeter(live) : ""}
  </section>`;
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
  return `<footer class="${busy ? "busy" : ""}"><i class="glyph ${status?.error ? "error" : busy ? "busy" : "ok"}"></i><span>${project}${line}</span><a data-act="settings" title="Hints, automatic checks">Settings</a></footer>`;
}

function render() {
  const scroll = window.scrollY;
  // attentry-ignore xss: every value is escaped by esc() or words() above, and the panel's CSP runs only Attentry's own script
  app.innerHTML = findings() + claudeCode() + footer();
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
  const act = e.target.closest("[data-act]");
  if (act) return vscode.postMessage({ type: act.dataset.act });
  const open = e.target.closest("[data-open]");
  // Findings' paths are the project's: inside the opened folder when the project is a folder in it.
  if (open) vscode.postMessage({ type: "open", file: data?.project ? `${data.project}/${open.dataset.open}` : open.dataset.open, line: Number(open.dataset.line) });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches(".row")) e.target.click();
});
window.addEventListener("message", ({ data: m }) => {
  if (m.type === "status") status = m.status;
  if (m.type === "findings") data = m.data;
  if (m.type === "agent") agent = m.info;
  render();
});
render();
vscode.postMessage({ type: "ready" });
