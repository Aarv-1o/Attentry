// The site's motion: things reveal as they scroll in (and hide again as they leave), the prompt
// types and erases what people ask agents, the globe turns with developers lighting up, the
// developers type, and the editor scene loops: Claude writes, Attentry spots, Claude fixes.
// Everything runs only while it's on screen, and not at all for people who ask for less motion.

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Calls on(true) when the element comes into view and on(false) when it leaves.
function whenVisible(el, on, threshold = 0.2) {
  new IntersectionObserver(([entry]) => on(entry.isIntersecting), { threshold }).observe(el);
}

// ---- Reveal, in and out ----
for (const el of document.querySelectorAll(".reveal")) {
  if (still) el.classList.add("in");
  else whenVisible(el, (seen) => el.classList.toggle("in", seen), 0.12);
}

// ---- Numbers count up each time they come into view ----
for (const el of document.querySelectorAll("[data-count]")) {
  const target = Number(el.dataset.count);
  const suffix = el.dataset.suffix ?? "";
  if (still) continue;
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
      const text = asks[i];
      for (let n = typed.textContent.length; n >= 0; n--) { typed.textContent = typed.textContent.slice(0, n); await wait(28); }
      for (let n = 1; n <= text.length; n++) { typed.textContent = text.slice(0, n); await wait(55 + Math.random() * 45); }
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

// ---- Developers type while they're on screen ----
for (const sprite of document.querySelectorAll("[data-sprite]")) {
  if (!still) whenVisible(sprite, (seen) => sprite.classList.toggle("typing", seen));
}

// ---- The globe: a dotted sphere turning, developers lighting up on it ----
const canvas = document.getElementById("globe");
if (canvas) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = 520;
  canvas.width = canvas.height = size * dpr;
  ctx.scale(dpr, dpr);
  const R = size * 0.38;
  const c = size / 2;
  // Evenly spread points (a Fibonacci sphere).
  const N = 900;
  const points = Array.from({ length: N }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    return { x: Math.cos(a) * r, y, z: Math.sin(a) * r };
  });
  const pins = Array.from({ length: 16 }, (_, i) => ({ p: points[(i * 131 + 57) % N], phase: i * 0.37 }));
  let running = false;

  const draw = (t) => {
    ctx.clearRect(0, 0, size, size);
    const turn = t * 0.00011;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const place = ({ x, y, z }) => ({ x: x * cos - z * sin, y, z: x * sin + z * cos });
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.stroke();
    for (const point of points) {
      const p = place(point);
      const depth = (p.z + 1) / 2; // 0 back, 1 front
      ctx.fillStyle = `rgba(242,244,247,${0.06 + depth * 0.5})`;
      ctx.beginPath();
      ctx.arc(c + p.x * R, c + p.y * R, 0.6 + depth * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const { p: point, phase } of pins) {
      const p = place(point);
      if (p.z < 0.05) continue; // only the side facing us
      const x = c + p.x * R;
      const y = c + p.y * R;
      const pulse = ((t / 1600 + phase) % 1);
      ctx.strokeStyle = `rgba(31,200,164,${(1 - pulse) * 0.7 * p.z})`;
      ctx.beginPath();
      ctx.arc(x, y, 3 + pulse * 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(31,200,164,${0.5 + p.z * 0.5})`;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (running) requestAnimationFrame(draw);
  };
  if (still) draw(0);
  else whenVisible(canvas, (seen) => {
    const was = running;
    running = seen;
    if (seen && !was) requestAnimationFrame(draw);
  }, 0);
}

// ---- The editor scene ----
// Each line: its code, and its part in the story (bad, copy, dead), with what Claude changes it to.
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
  let visible = false;
  let playing = false;

  const step = (name) => {
    scene.dataset.step = name;
    captions.forEach((c) => c.classList.toggle("on", c.dataset.cap === name));
  };
  const lineEl = (line) => {
    const el = document.createElement("div");
    el.className = `ln${line.role ? ` ${line.role}-line` : ""}`;
    // attentry-ignore xss: LINES is a constant in this file, never anything a visitor sends
    el.innerHTML = `<span class="t">${line.html}</span>`;
    return el;
  };
  // Types a line out: the text is revealed left to right, a character at a time.
  const type = async (el) => {
    const t = el.querySelector(".t");
    const n = Math.max(1, t.textContent.length);
    t.style.clipPath = "inset(0 100% 0 0)";
    t.getBoundingClientRect();
    t.style.transition = `clip-path ${n * 22}ms steps(${n})`;
    t.style.clipPath = "inset(0 0 0 0)";
    await wait(n * 22 + 60);
  };
  const reset = () => {
    code.replaceChildren(...LINES.map(lineEl));
    Object.values(findings).forEach((f) => f.classList.remove("show", "done"));
    state.textContent = "watching";
    step("write");
  };
  const showFinal = () => {
    code.replaceChildren(...LINES.filter((l) => !l.drop).map((l) => lineEl({ ...l, html: l.fix ?? l.html, role: l.fix ? "fixed" : undefined })));
    code.querySelectorAll(".fixed-line").forEach((el) => el.classList.add("fixed"));
    Object.values(findings).forEach((f) => f.classList.add("show", "done"));
    state.textContent = "clean";
    step("done");
  };

  const play = async () => {
    playing = true;
    while (visible) {
      reset();
      const els = [...code.children];
      els.forEach((el) => el.querySelector(".t").style.clipPath = "inset(0 100% 0 0)");
      // Claude writes.
      for (const el of els) { if (!visible) break; await type(el); }
      await wait(500);
      // Attentry spots.
      step("watch");
      state.textContent = "3 problems";
      LINES.forEach((l, i) => { if (l.role) els[i].classList.add(l.role === "bad" ? "bad" : l.role === "copy" ? "copy" : "dead"); });
      for (const key of ["secret", "copy", "dead"]) { findings[key].classList.add("show"); await wait(650); }
      await wait(1400);
      // Claude fixes: the secret, then the copy (an import instead), then the dead code goes.
      step("fix");
      state.textContent = "fixing";
      const fixLine = async (i, key) => {
        const el = els[i];
        el.className = "ln fixed";
        // attentry-ignore xss: LINES is a constant in this file, never anything a visitor sends
        el.querySelector(".t").innerHTML = LINES[i].fix;
        await type(el);
        if (key) findings[key].classList.add("done");
      };
      await fixLine(2, "secret");
      await wait(400);
      await fixLine(4);
      for (const i of [5, 6, 7]) els[i].classList.add("gone");
      findings.copy.classList.add("done");
      await wait(700);
      for (const i of [9, 10, 11, 12]) els[i].classList.add("gone");
      findings.dead.classList.add("done");
      await wait(600);
      els.forEach((el) => el.classList.contains("gone") && (el.style.display = "none"));
      // The change card.
      step("done");
      state.textContent = "clean";
      await wait(4200);
      // Out, and round again.
      code.style.transition = "opacity 0.5s";
      code.style.opacity = "0";
      await wait(550);
      code.style.opacity = "1";
    }
    playing = false;
  };

  if (still) showFinal();
  else {
    reset();
    whenVisible(scene, (seen) => {
      visible = seen;
      if (seen && !playing) play();
    }, 0.35);
  }
}
