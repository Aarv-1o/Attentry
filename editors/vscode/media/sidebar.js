// The panel's page: draws what it's sent (status, findings, agent) and sends back what's clicked.
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

function ago(time) {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${plural(m, "minute")} ago` : `${plural(Math.round(m / 60), "hour")} ago`;
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

function note() {
  if (!data) return "";
  const where = data.project ? `Checking <b>${esc(data.project)}</b>, the project in the folder you opened. ` : "";
  if ((status?.show ?? data.show) === "all") return `${where}Everything in the repo.`;
  if (data.noChanges) return `${where}Can't tell what changed (${esc(data.noChanges)}), so this is everything.`;
  return `${where}What this branch or your uncommitted work added.${data.older ? ` ${plural(data.older, "older finding")} hidden.` : ""}`;
}

// "Your changes" means everything when Detron can't tell what changed: say so, not "in your changes".
const clearText = (show) => (show === "changes" && !data?.noChanges ? "in your changes" : "in this repo");

function findings() {
  const show = status?.show ?? data?.show ?? "changes";
  const items = data?.items ?? [];
  const hotspots = items.filter((f) => f.rule === "hotspot");
  const of = (part) => items.filter((f) => f.part === part && f.rule !== "hotspot");
  const found = PARTS.filter(([part]) => of(part).length);
  const total = PARTS.reduce((n, [part]) => n + of(part).length, 0);
  // One bar, split by how much each part has: the shape of the problem at a glance.
  const bar = total
    ? PARTS.filter(([part]) => of(part).length).map(([part, , tone]) => `<i class="${tone}" style="flex:${of(part).length}"></i>`).join("")
    : `<i class="none"></i>`;
  const tally = PARTS.map(([part, name, tone]) => `<button class="tally ${of(part).length ? "" : "zero"}" data-jump="${part}"><i class="glyph ${tone}"></i><b>${of(part).length}</b> ${esc(name)}</button>`).join("");
  const groups = found.map(([part, name]) => `<details id="${part}" ${part !== "cleanup" || found.length === 1 ? "open" : ""}><summary>${esc(name)}<span class="n">${of(part).length}</span></summary>${of(part).map(item).join("")}</details>`).join("");
  const done = data && !status?.scanning;
  return `<section class="findings">
    <header><h2>Findings</h2>
      <div class="tabs" role="tablist" aria-label="What to show">
        <button role="tab" data-act="toggleShow" aria-selected="${show === "changes"}" ${show === "changes" ? "disabled" : ""}>Your changes</button>
        <button role="tab" data-act="toggleShow" aria-selected="${show === "all"}" ${show === "all" ? "disabled" : ""}>Whole repo</button>
      </div>
    </header>
    <div class="bar ${status?.scanning ? "busy" : ""}" aria-hidden="true">${bar}</div>
    <div class="tallies">${tally}</div>
    <p class="note">${note()}</p>
    ${done && !total ? `<p class="clear">No problems ${clearText(show)}.${show === "changes" && data.older ? ` <a data-act="toggleShow">Show ${plural(data.older, "older finding")}</a>` : ""}</p>` : groups}
    ${hotspots.length ? `<details id="hotspots"><summary>Hotspots<span class="n">${hotspots.length}</span></summary><p class="quiet">Files that change often and are complex: change them in small steps and test after each.</p>${hotspots.map((h) => `<div class="row" tabindex="0" data-open="${esc(h.file)}" data-line="1"><i class="glyph hint"></i><span class="title">${esc(h.file)}</span><span class="does">${esc(h.title)}</span></div>`).join("")}</details>` : ""}
    <label class="check"><input type="checkbox" data-act="toggleHints" ${data?.hints ? "checked" : ""}> Show hints Detron is less sure about</label>
  </section>`;
}

// ---- Scanning ----

// One tick per edit between check-ins: filled ones are edits since the last check-in.
function checkInMeter() {
  if (!agent || agent.hooks !== "connected") return "";
  if (!agent.live) return `<p class="quiet">Your agent checks in every 10 edits. Waiting for its first edit.</p>`;
  const { untilCheckIn, checkInEvery } = agent.live;
  const done = checkInEvery - untilCheckIn;
  const fresh = lastDone !== undefined && done !== lastDone;
  lastDone = done;
  const ticks = Array.from({ length: checkInEvery }, (_, i) => `<i class="${i < done ? "on" : ""}${i === done - 1 && fresh ? " new" : ""}"></i>`).join("");
  return `<div class="meter" role="img" aria-label="${done} of ${checkInEvery} edits until the agent's next check-in">
    <p>Agent check-in in <b>${plural(untilCheckIn, "edit")}</b></p><div class="ticks" style="grid-template-columns:repeat(${checkInEvery},1fr)">${ticks}</div></div>`;
}

function scanning() {
  const busy = !status || status.scanning;
  const line = status?.error
    ? `<span class="bad">Scan failed: ${esc(status.error)}</span>`
    : busy ? "Checking your code…" : `Up to date, checked ${status.lastScanAt ? ago(status.lastScanAt) : "just now"}`;
  return `<section class="scanning ${busy ? "busy" : ""}">
    <header><h2>Scanning</h2><button class="ghost" data-act="rescan" ${busy ? "disabled" : ""}>Scan your repo</button></header>
    <p class="state"><i class="glyph ${status?.error ? "error" : busy ? "busy" : "ok"}"></i>${line}</p>
    <label class="switch"><input type="checkbox" role="switch" data-act="toggleAuto" ${status?.autoScan !== false ? "checked" : ""}><span class="track"></span>
      <span>Check automatically when files change</span></label>
    ${checkInMeter()}
  </section>`;
}

// ---- Your agent ----

// The panel remembers the person's choice of connecting the MCP tools too.
const saved = vscode.getState() ?? {};
let withMcp = saved.withMcp ?? true;

function connectionRow(name, state, help) {
  const [tone, text] = { connected: ["ok", "Connected"], added: ["ok", "Added"], stale: ["warn", "Needs reconnecting"], missing: ["off", "Not set up"] }[state] ?? ["off", "Not set up"];
  return `<div class="conn" title="${esc(help)}"><span>${esc(name)}</span><span class="pill ${tone}"><i></i>${text}</span></div>`;
}

function yourAgent() {
  if (!agent) return `<section class="agent"><h2>Your agent</h2><p class="quiet">Looking…</p></section>`;
  const working = agent.live && Date.now() - agent.live.lastEditAt < LIVE_MS;
  const connected = agent.hooks === "connected";
  const state = connected ? (working ? ["live", "Working now"] : ["ok", "Connected"]) : agent.hooks === "stale" ? ["warn", "Needs reconnecting"] : ["off", "Not connected"];
  const live = agent.live;
  const tests = live?.tests ? `<p class="tests ${esc(live.tests.state)}"><i class="glyph ${live.tests.state === "passed" ? "ok" : live.tests.state === "failed" || live.tests.state === "timeout" ? "error" : live.tests.state === "running" ? "busy" : "hint"}"></i>Tests: ${esc(live.tests.text)}</p>` : "";
  const task = live ? `<p class="task">${working ? "This task" : "Last task"}: ${plural(live.edits, "edit")} to ${plural(live.files ?? 0, "file")}, ${live.added ? `<b>${plural(live.added, "problem")} added</b>` : "no problems added"}${working ? "" : `, ${ago(live.lastEditAt)}`}.</p>${tests}` : "";
  const mode = agent.mode;
  const mcpNeeded = agent.mcp && agent.mcp !== "added";
  const connect = connected
    ? (mcpNeeded ? `<button class="ghost wide" data-act="connectMcp">${agent.mcp === "stale" ? "Re-add the MCP tools" : "Add the MCP tools"}</button>` : "")
    : `<p class="quiet">${agent.hooks === "stale" ? "The agent's hooks point to an old copy of Detron, which moves when the extension updates." : "Detron tells your agent about problems right after each edit, and checks in every 10 edits."}</p>
      <label class="check"><input type="checkbox" data-act="withMcp" ${withMcp ? "checked" : ""}> Also add the MCP tools, so the agent can ask Detron itself (find_existing, check, explain)</label>
      <button class="primary wide" data-act="connectAgent">${agent.hooks === "stale" ? "Reconnect Claude Code" : "Connect Claude Code"}</button>`;
  return `<section class="agent">
    <h2>Your agent</h2>
    <div class="who"><span class="name">Claude Code</span><span class="pill ${state[0]}"><i></i>${state[1]}</span></div>
    ${connected ? task : ""}
    <div class="conns">
      ${connectionRow("Hooks", agent.hooks, "Run on every edit, whether the agent remembers or not: tell it about copies and new problems")}
      ${agent.mcp ? connectionRow("MCP tools", agent.mcp, "Tools the agent calls when it wants: find_existing, check, explain") : ""}
    </div>
    ${connect}
    <div class="mode">
      <div class="tabs" role="tablist" aria-label="How strict">
        <button role="tab" data-mode="suggest" aria-selected="${mode === "suggest"}" ${mode === "suggest" ? "disabled" : ""}>Suggest</button>
        <button role="tab" data-mode="block" aria-selected="${mode === "block"}" ${mode === "block" ? "disabled" : ""}>Block</button>
      </div>
      <p class="quiet">${mode === "block" ? "Problems are sent back as errors, and a task can't finish while it has added security or crash problems." : "Detron tells the agent, and never stops it."}</p>
    </div>
    <p class="quiet">Cursor and Copilot CLI use the same hooks. New tools show up in a new agent session.</p>
  </section>`;
}

function render() {
  const scroll = window.scrollY;
  // detron-ignore xss: every value is escaped by esc() or words() above, and the panel's CSP runs only Detron's own script
  app.innerHTML = findings() + scanning() + yourAgent();
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
  if (act?.dataset.act === "connectAgent") return vscode.postMessage({ type: "connectAgent", withMcp });
  if (act && act.tagName !== "INPUT") return vscode.postMessage({ type: act.dataset.act });
  const open = e.target.closest("[data-open]");
  if (open) vscode.postMessage({ type: "open", file: open.dataset.open, line: Number(open.dataset.line) });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches(".item")) e.target.click();
});
document.addEventListener("change", (e) => {
  if (e.target.dataset.act === "toggleHints" || e.target.dataset.act === "toggleAuto") vscode.postMessage({ type: e.target.dataset.act });
  if (e.target.dataset.act === "withMcp") {
    withMcp = e.target.checked;
    vscode.setState({ ...saved, withMcp });
  }
});
window.addEventListener("message", ({ data: m }) => {
  if (m.type === "status") status = m.status;
  if (m.type === "findings") data = m.data;
  if (m.type === "agent") agent = m.info;
  render();
});
render();
vscode.postMessage({ type: "ready" });
