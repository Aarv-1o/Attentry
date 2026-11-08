// The site's motion: things reveal as they scroll in (and hide again as they leave), the prompt
// types and erases what people ask agents, the globe turns with developers lighting up, problems
// pop up around the frustrated developer, the agent edits a file in a small VS Code, and the
// editor scene loops: Claude writes, Attentry spots, Claude fixes.
// Everything runs only while it's on screen, and not at all for people who ask for less motion.

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Calls on(true) when the element comes into view and on(false) when it leaves.
function whenVisible(el, on, threshold = 0.2) {
  new IntersectionObserver(([entry]) => on(entry.isIntersecting), { threshold }).observe(el);
}

// Runs scene() in a loop while el is on screen; picks up again when it comes back.
function loopWhileVisible(el, scene, threshold) {
  let visible = false;
  let playing = false;
  whenVisible(el, async (seen) => {
    visible = seen;
    if (!seen || playing) return;
    playing = true;
    while (visible) await scene(() => visible);
    playing = false;
  }, threshold);
}

// A line of code. The code shown on this page is constants in this file, never visitor input.
function codeLine(html, cls = "") {
  const el = document.createElement("div");
  el.className = `ln ${cls}`.trim();
  // attentry-ignore xss: the code shown is constants in this file, never anything a visitor sends
  el.innerHTML = `<span class="t">${html}</span>`;
  return el;
}
function setCode(el, html) {
  // attentry-ignore xss: the code shown is constants in this file, never anything a visitor sends
  el.querySelector(".t").innerHTML = html;
}

// Types a line out: its text revealed left to right, a character at a time.
async function typeLine(el, perChar = 22) {
  const t = el.querySelector(".t");
  const n = Math.max(1, t.textContent.length);
  t.style.transition = "none";
  t.style.clipPath = "inset(0 100% 0 0)";
  t.getBoundingClientRect();
  t.style.transition = `clip-path ${n * perChar}ms steps(${n})`;
  t.style.clipPath = "inset(0 0 0 0)";
  await wait(n * perChar + 60);
}

// Fades a code area out and back in, between two rounds of a loop.
async function fadeRound(el) {
  el.style.transition = "opacity 0.45s";
  el.style.opacity = "0";
  await wait(480);
  el.style.opacity = "1";
}

// ---- Reveal, in and out ----
for (const el of document.querySelectorAll(".reveal")) {
  if (still) el.classList.add("in");
  else whenVisible(el, (seen) => el.classList.toggle("in", seen), 0.12);
}

// ---- Numbers count up each time they come into view ----
for (const el of document.querySelectorAll("[data-count]")) {
  if (still) continue;
  const target = Number(el.dataset.count);
  const suffix = el.dataset.suffix ?? "";
  whenVisible(el, (seen) => {
    if (!seen) return void (el.textContent = `0${suffix}`);
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / 1200);
      el.textContent = `${Math.round(target * (1 - (1 - p) ** 3))}${suffix}`;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, 0.6);
}

// ---- The prompt: what people ask their agent, typed and erased ----
const typed = document.getElementById("typed");
const asks = ["build me an Uber clone", "add login with JWT", "make the chat realtime", "fix the checkout bug", "add a dashboard for admins"];
if (typed && !still) {
  (async () => {
    for (let i = 0; ; i = (i + 1) % asks.length) {
      for (let n = typed.textContent.length; n >= 0; n--) { typed.textContent = typed.textContent.slice(0, n); await wait(28); }
      for (let n = 1; n <= asks[i].length; n++) { typed.textContent = asks[i].slice(0, n); await wait(55 + Math.random() * 45); }
      await wait(1800);
    }
  })();
}

// ---- Speech bubbles around the globe, one at a time ----
const bubbles = [...document.querySelectorAll(".bubble")];
if (bubbles.length && !still) {
  let b = 0;
  setInterval(() => {
    bubbles.forEach((el, i) => el.classList.toggle("show", i === b));
    b = (b + 1) % bubbles.length;
  }, 2200);
}

// ---- The developer types: the finger goes down to the key and back up, while on screen ----
for (const sprite of document.querySelectorAll("[data-sprite]")) {
  const frames = [...sprite.querySelectorAll(".frame:not(.hold)")];
  if (still || !frames.length) continue;
  const order = [0, 1, 2, 3, 4, 3, 2, 1]; // lifted → pressing → lifted
  let k = 0;
  let timer;
  whenVisible(sprite, (seen) => {
    clearInterval(timer);
    if (!seen) return;
    timer = setInterval(() => {
      k = (k + 1) % order.length;
      frames.forEach((f, i) => f.classList.toggle("on", i === order[k]));
    }, 85);
  });
}

// ---- The problems pop up around the frustrated developer while she's on screen ----
const costArt = document.getElementById("cost-art");
if (costArt && !still) whenVisible(costArt, (seen) => costArt.classList.toggle("live", seen));

// ---- The globe: a dotted sphere turning, developers lighting up on it ----
// Drawn at the canvas's real size on screen times the screen's pixel density, so it stays sharp.
const canvas = document.getElementById("globe");
if (canvas) {
  const ctx = canvas.getContext("2d");
  const N = 1500;
  const points = Array.from({ length: N }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const a = i * Math.PI * (3 - Math.sqrt(5)); // a Fibonacci sphere: evenly spread
    return { x: Math.cos(a) * r, y, z: Math.sin(a) * r };
  });
  const pins = Array.from({ length: 18 }, (_, i) => ({ p: points[(i * 137 + 61) % N], phase: i * 0.29 }));
  const TILT = 0.32; // the axis leans a little, like a desk globe
  let size = 0;
  let running = false;

  const draw = (t) => {
    const R = size * 0.4;
    const c = size / 2;
    const cos = Math.cos(t * 0.0001);
    const sin = Math.sin(t * 0.0001);
    const place = ({ x, y, z }) => {
      const x1 = x * cos - z * sin;
      const z1 = x * sin + z * cos;
      return { x: x1, y: y * Math.cos(TILT) - z1 * Math.sin(TILT), z: y * Math.sin(TILT) + z1 * Math.cos(TILT) };
    };
    ctx.clearRect(0, 0, size, size);
    const glow = ctx.createRadialGradient(c, c, R * 0.6, c, c, R * 1.25);
    glow.addColorStop(0, "rgba(31,200,164,0.06)");
    glow.addColorStop(1, "rgba(31,200,164,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Lines of latitude and longitude, on the side facing us, as hairlines.
    const curve = (pointAt) => {
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k <= 96; k++) {
        const p = place(pointAt((k / 96) * Math.PI * 2));
        if (p.z < 0) { pen = false; continue; }
        const X = c + p.x * R;
        const Y = c + p.y * R;
        if (pen) ctx.lineTo(X, Y);
        else ctx.moveTo(X, Y);
        pen = true;
      }
      ctx.stroke();
    };
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(242,244,247,0.07)";
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = Math.sin((lat * Math.PI) / 180);
      const r = Math.cos((lat * Math.PI) / 180);
      curve((a) => ({ x: Math.cos(a) * r, y, z: Math.sin(a) * r }));
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const l = (lon * Math.PI) / 180;
      curve((a) => ({ x: Math.cos(a) * Math.cos(l), y: Math.sin(a), z: Math.cos(a) * Math.sin(l) }));
    }
    ctx.strokeStyle = "rgba(242,244,247,0.16)";
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.stroke();

    // The dots: bigger and brighter toward us, faint on the far side.
    for (const point of points) {
      const p = place(point);
      if (p.z < -0.2) continue;
      const depth = (p.z + 1) / 2;
      ctx.fillStyle = `rgba(242,244,247,${(0.08 + depth ** 2 * 0.72).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(c + p.x * R, c + p.y * R, 0.7 + depth * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Developers coding with agents, pulsing.
    for (const { p: point, phase } of pins) {
      const p = place(point);
      if (p.z < 0.08) continue;
      const X = c + p.x * R;
      const Y = c + p.y * R;
      const pulse = (t / 1700 + phase) % 1;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(31,200,164,${((1 - pulse) * 0.8 * p.z).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(X, Y, 3.5 + pulse * 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#1fc8a4";
      ctx.beginPath();
      ctx.arc(X, Y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (running) requestAnimationFrame(draw);
  };

  const fit = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    size = canvas.clientWidth;
    canvas.width = canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!running) draw(0);
  };
  new ResizeObserver(fit).observe(canvas);
  if (!still) whenVisible(canvas, (seen) => {
    const was = running;
    running = seen;
    if (seen && !was) requestAnimationFrame(draw);
  }, 0);
}

// ---- The agent at work: the chat asks, the file in the middle changes ----
const miniCode = document.getElementById("mini-code");
const miniChat = document.getElementById("mini-chat");
if (miniCode && miniChat) {
  const status = document.getElementById("mini-status");
  const BEFORE = [
    '<span class="k">export function</span> <span class="f">checkout</span>(cart) {',
    '  <span class="k">const</span> total = <span class="f">sum</span>(cart.items);',
    '  <span class="k">return</span> <span class="f">charge</span>(cart.user, total);',
    "}",
  ];
  const COUPON = '  <span class="k">const</span> coupon = <span class="f">findCoupon</span>(cart.code);';
  // Short lines, so the whole file fits beside the chat.
  const DUE = '  <span class="k">const</span> due = <span class="f">applyCoupon</span>(total, coupon);';
  const RETURN = '  <span class="k">return</span> <span class="f">charge</span>(cart.user, due);';
  const HELPER = [
    '<span class="k">function</span> <span class="f">applyCoupon</span>(total, coupon) {',
    '  <span class="k">if</span> (!coupon) <span class="k">return</span> total;',
    '  <span class="k">return</span> total * (1 - coupon.off);',
    "}",
  ];
  const say = async (text, cls) => {
    const el = document.createElement("p");
    el.className = `msg ${cls}`;
    el.textContent = text;
    miniChat.append(el);
    el.getBoundingClientRect();
    el.classList.add("show");
    while (miniChat.children.length > 5) miniChat.firstElementChild.remove();
    await wait(700);
  };

  if (still) {
    miniCode.replaceChildren(codeLine(BEFORE[0]), codeLine(COUPON, "added"), codeLine(BEFORE[1]), codeLine(DUE, "added"), codeLine(RETURN, "changed"), codeLine(BEFORE[3]), codeLine(""), ...HELPER.map((h) => codeLine(h, "added")));
    status.textContent = "1 file changed";
  } else {
    miniCode.replaceChildren(...BEFORE.map((h) => codeLine(h)));
    loopWhileVisible(miniCode, async () => {
      miniCode.replaceChildren(...BEFORE.map((h) => codeLine(h)));
      miniChat.replaceChildren();
      status.textContent = "waiting…";
      await wait(600);
      await say("add a coupon code at checkout", "you");
      status.textContent = "reading…";
      await say("Reading checkout.ts", "agent");
      await say("Adding the coupon to checkout()", "agent");
      status.textContent = "editing…";
      const coupon = codeLine(COUPON, "added");
      miniCode.children[0].after(coupon);
      await typeLine(coupon, 26);
      await wait(300);
      const due = codeLine(DUE, "added");
      miniCode.children[2].after(due);
      await typeLine(due, 24);
      await wait(250);
      const ret = miniCode.children[4];
      ret.className = "ln changed";
      setCode(ret, RETURN);
      await typeLine(ret);
      await wait(300);
      const helper = HELPER.map((h) => codeLine(h, "added"));
      miniCode.append(codeLine(""), ...helper);
      for (const el of helper) await typeLine(el, 24);
      await say("Done: checkout.ts updated", "agent done");
      status.textContent = "1 file changed";
      await wait(3600);
      await fadeRound(miniCode);
    }, 0.4);
  }
}

// ---- The editor scene: Claude writes, Attentry spots, Claude fixes ----
// Each line: its code, its part in the story (bad, copy, dead), and what Claude changes it to.
const LINES = [
  { html: '<span class="k">const</span> express = <span class="f">require</span>(<span class="s">"express"</span>);' },
  { html: '<span class="k">const</span> jwt = <span class="f">require</span>(<span class="s">"jsonwebtoken"</span>);' },
  { html: '<span class="k">const</span> SECRET = <span class="flag">process.env.JWT_SECRET || <span class="s">"superSecret"</span></span>;', role: "bad",
    fix: '<span class="k">const</span> SECRET = process.env.JWT_SECRET; <span class="c">// required at startup</span>' },
  { html: "" },
  { html: '<span class="k">function</span> <span class="flag"><span class="f">formatTimeAgo</span>(date)</span> {', role: "copy",
    fix: '<span class="k">const</span> { timeAgo } = <span class="f">require</span>(<span class="s">"./utils/time"</span>);' },
  { html: '  <span class="k">const</span> s = (Date.now() - date) / <span class="s">1000</span>;', role: "copy", drop: true },
  { html: '  <span class="k">return</span> s &lt; 60 ? <span class="s">"just now"</span> : Math.round(s / 60) + <span class="s">"m ago"</span>;', role: "copy", drop: true },
  { html: "}", role: "copy", drop: true },
  { html: "" },
  { html: '<span class="k">function</span> <span class="flag"><span class="f">oldPriceFormat</span>(cents)</span> {', role: "dead", drop: true },
  { html: '  <span class="k">return</span> <span class="s">"$"</span> + cents / <span class="s">100</span>;', role: "dead", drop: true },
  { html: "}", role: "dead", drop: true },
  { html: "", role: "dead", drop: true },
  { html: 'app.<span class="f">post</span>(<span class="s">"/login"</span>, (req, res) =&gt; {' },
  { html: '  res.<span class="f">json</span>({ token: jwt.<span class="f">sign</span>(req.body, SECRET) });' },
  { html: "});" },
];

const scene = document.getElementById("scene");
const code = document.getElementById("code");
if (scene && code) {
  const state = document.getElementById("panel-state");
  const findings = Object.fromEntries([...scene.querySelectorAll("[data-finding]")].map((el) => [el.dataset.finding, el]));
  const captions = [...scene.querySelectorAll("[data-cap]")];
  const ORDER = ["write", "watch", "fix", "done"];
  const LABEL = { write: "watching", watch: "3 problems", fix: "fixing", done: "clean" };
  const step = (name) => {
    scene.dataset.step = name;
    state.textContent = LABEL[name];
    captions.forEach((c) => c.classList.toggle("on", c.dataset.cap === name));
  };

  // A click on a step starts a new run; the old one stops at its next pause.
  class Stopped extends Error {}
  let run = 0;
  let visible = false;
  const check = (id) => { if (id !== run) throw new Stopped(); };
  const pause = async (ms, id) => { await wait(ms); check(id); };

  // Each step's end state, set at once: for jumping straight to a later step.
  const written = () => {
    const els = LINES.map((l) => codeLine(l.html));
    code.replaceChildren(...els);
    return els;
  };
  const flag = (els) => LINES.forEach((l, i) => l.role && els[i].classList.add(l.role));
  const fixLineNow = (els, i) => { els[i].className = "ln fixed"; setCode(els[i], LINES[i].fix); };
  const dropLines = (els) => els.forEach((el, i) => LINES[i].drop && (el.style.display = "none"));

  // Each step, animated, from the state the previous one left.
  const animate = {
    async write(id) {
      const els = written();
      els.forEach((el) => (el.querySelector(".t").style.clipPath = "inset(0 100% 0 0)"));
      Object.values(findings).forEach((f) => f.classList.remove("show", "done"));
      step("write");
      for (const el of els) { await typeLine(el); check(id); }
      await pause(500, id);
      return els;
    },
    async watch(id, els) {
      step("watch");
      flag(els);
      for (const key of ["secret", "copy", "dead"]) { findings[key].classList.add("show"); await pause(650, id); }
      await pause(1400, id);
      return els;
    },
    async fix(id, els) {
      step("fix");
      fixLineNow(els, 2);
      await typeLine(els[2]);
      check(id);
      findings.secret.classList.add("done");
      await pause(400, id);
      fixLineNow(els, 4);
      await typeLine(els[4]);
      check(id);
      for (const i of [5, 6, 7]) els[i].classList.add("gone");
      findings.copy.classList.add("done");
      await pause(700, id);
      for (const i of [9, 10, 11, 12]) els[i].classList.add("gone");
      findings.dead.classList.add("done");
      await pause(600, id);
      dropLines(els);
      return els;
    },
    async done(id, els) {
      step("done");
      await pause(4200, id);
      await fadeRound(code);
      check(id);
      return els;
    },
  };

  // Plays from a step: the steps before it are set at once, the rest animate, then it loops from
  // the start while the scene is on screen.
  let playing = false;
  const play = async (from) => {
    const id = ++run;
    playing = true;
    try {
      let start = ORDER.indexOf(from);
      for (;;) {
        let els;
        if (start > 0) {
          els = written();
          Object.values(findings).forEach((f) => f.classList.remove("show", "done"));
          if (start > 1) { flag(els); Object.values(findings).forEach((f) => f.classList.add("show")); }
          if (start > 2) { fixLineNow(els, 2); fixLineNow(els, 4); dropLines(els); Object.values(findings).forEach((f) => f.classList.add("done")); }
        }
        for (const name of ORDER.slice(start)) els = await animate[name](id, els);
        if (!visible) return;
        start = 0;
      }
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
    } finally {
      if (id === run) playing = false; // a newer run (a click) is still playing otherwise
    }
  };

  if (still) {
    const els = written();
    fixLineNow(els, 2);
    fixLineNow(els, 4);
    dropLines(els);
    Object.values(findings).forEach((f) => f.classList.add("show", "done"));
    step("done");
    // Without motion, a step button still shows that step's state.
    for (const c of captions) {
      c.addEventListener("click", () => {
        const at = ORDER.indexOf(c.dataset.cap);
        const now = written();
        Object.values(findings).forEach((f) => f.classList.toggle("show", at >= 1));
        Object.values(findings).forEach((f) => f.classList.toggle("done", at >= 2));
        if (at >= 1) flag(now);
        if (at >= 2) { fixLineNow(now, 2); fixLineNow(now, 4); dropLines(now); }
        step(c.dataset.cap);
      });
    }
  } else {
    written();
    step("write");
    for (const c of captions) c.addEventListener("click", () => play(c.dataset.cap));
    whenVisible(scene, (seen) => {
      visible = seen;
      if (seen && !playing) play("write");
    }, 0.35);
  }
}

// ---- Ask it what it catches: press send, the answer pops up; then "Explain again" is typed in ----
const chat = document.getElementById("chat");
if (chat) {
  const log = document.getElementById("chat-log");
  const welcome = document.getElementById("chat-welcome");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-q");
  const send = form.querySelector(".send");
  const answer = document.getElementById("chat-answer");
  const FIRST = "What does Attentry catch?";
  const AGAIN = "Explain again";
  let busy = false;

  const fromYou = (text) => {
    const row = document.createElement("div");
    row.className = "msg from-you";
    const avatar = document.createElement("span");
    avatar.className = "avatar avatar-you";
    avatar.textContent = "You";
    const body = document.createElement("div");
    const bubble = document.createElement("p");
    bubble.className = "bubble-you";
    bubble.textContent = text;
    const when = document.createElement("p");
    when.className = "when-sent";
    when.textContent = "just now";
    body.append(bubble, when);
    row.append(avatar, body);
    return row;
  };
  // Types the next question into the box, then invites a press.
  const offer = async (text) => {
    if (still) input.value = text;
    else for (let n = 1; n <= text.length; n++) { input.value = text.slice(0, n); await wait(60); }
    send.disabled = false;
    chat.classList.add("ready");
  };

  const ask = async () => {
    if (busy || !input.value) return;
    busy = true;
    chat.classList.remove("ready");
    send.disabled = true;
    const question = input.value;
    input.value = "";
    // A new round starts from the welcome, so the replay animates like the first time.
    if (question === AGAIN && !still) {
      log.style.transition = "opacity 0.3s";
      log.style.opacity = "0";
      await wait(320);
      log.style.opacity = "1";
    }
    log.replaceChildren(welcome, fromYou(question));
    if (!still) {
      const thinking = document.createElement("span");
      thinking.className = "thinking";
      thinking.setAttribute("aria-label", "Attentry is answering");
      thinking.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
      log.append(thinking);
      await wait(900);
      thinking.remove();
    }
    // The answer is a <template> in the page; each card pops in a beat after the last.
    const copy = answer.content.cloneNode(true);
    copy.querySelectorAll(".answer").forEach((el, i) => el.style.setProperty("--n", String(i)));
    log.append(copy);
    await wait(still ? 0 : 6 * 120 + 500);
    busy = false;
    await offer(AGAIN);
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void ask();
  });
  input.value = FIRST;
  chat.classList.add("ready");
}
