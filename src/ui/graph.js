/*
 * Galaxy view of the credential pool.
 *
 * The core is the gateway; each Auth is a small luminous orb on an orbit whose
 * radius encodes its state — healthy orbits close in, cooling further out, dead
 * on the cold outer ring. Inner orbits move faster, which reads as a system
 * rather than a diagram.
 *
 * Orbs are labelled with the Auth *name*, never the email.
 */

/*
 * Orb colours match the dashboard's state palette, and the gateway core is the
 * logo's orange — it is the identity anchor at the centre of the galaxy.
 * Kept as RGB triples because canvas gradients need per-stop alpha, which CSS
 * custom properties cannot supply here.
 */
const STATE = {
  active: { rgb: [78, 201, 138], radius: 0.4, speed: 1.0 },
  cooling: { rgb: [232, 195, 61], radius: 0.66, speed: 0.55 },
  dead: { rgb: [242, 85, 90], radius: 0.92, speed: 0.16 },
};
/** Keyhole orange, the same value as --accent. */
const CORE_RGB = [247, 147, 30];
/** The violet from the A, used for the nebula wash and orbit lines. */
const VIOLET_RGB = [139, 63, 232];

const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

export class GalaxyGraph {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tooltip = tooltipEl;

    this.nodes = new Map();
    this.stars = [];
    this.w = 0;
    this.h = 0;
    this.cssW = 0;
    this.cssH = 0;
    this.t = 0;
    this.hovered = null;
    this.onSelect = null;

    this.resize();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.bindPointer();

    this.alive = true;
    this.last = performance.now();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  /**
   * Halt the render loop. The dashboard re-creates the graph on every visit to
   * Home, so without this each visit would leave another rAF loop running.
   */
  stop() {
    this.alive = false;
    this.observer?.disconnect();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = rect.width;
    this.h = rect.height;
    this.cssW = this.canvas.clientWidth;
    this.cssH = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seedStars();
  }

  /** Static starfield, regenerated on resize so density stays even. */
  seedStars() {
    const count = Math.round((this.w * this.h) / 5200);
    this.stars = Array.from({ length: count }, (_, i) => ({
      x: Math.random() * this.w,
      y: Math.random() * this.h,
      r: Math.random() * 0.9 + 0.3,
      a: Math.random() * 0.35 + 0.06,
      // Deterministic per-star phase so twinkle does not pulse in unison.
      phase: (i * 2.399) % (Math.PI * 2),
    }));
  }

  /** Longest orbit radius that still leaves room for labels. */
  get maxRadius() {
    return Math.max(70, Math.min(this.w, this.h) / 2 - 46);
  }

  sync(credentials) {
    const seen = new Set();

    credentials.forEach((cred, i) => {
      seen.add(cred.id);
      let node = this.nodes.get(cred.id);
      if (!node) {
        node = {
          id: cred.id,
          // Golden-angle spacing keeps orbs from clumping as the pool grows.
          angle: i * 2.399963,
          r: 0,
          targetR: 0,
          pulses: [],
          flash: 0,
          x: 0,
          y: 0,
        };
        this.nodes.set(cred.id, node);
      }
      node.cred = cred;
      node.state = cred.effectiveState;
      node.targetR = this.maxRadius * (STATE[node.state] ?? STATE.dead).radius;
      if (node.r === 0) node.r = node.targetR;
      // Orb size grows slowly with traffic, capped so one busy Auth cannot
      // dominate the view.
      node.size = 4.5 + Math.min(5.5, Math.sqrt(Math.min(cred.requestCount, 2500)) * 0.16);
    });

    for (const id of [...this.nodes.keys()]) if (!seen.has(id)) this.nodes.delete(id);
  }

  /** Fire a particle from an orb toward the core. */
  pulse(credentialId, tone = "ok") {
    const node = this.nodes.get(credentialId);
    if (!node) return;
    node.pulses.push({ t: 0, tone });
    node.flash = 1;
  }

  step(dtMs) {
    const dt = Math.min(dtMs, 50) / 1000;
    this.t += dt;

    for (const node of this.nodes.values()) {
      const cfg = STATE[node.state] ?? STATE.dead;
      // Inner orbits sweep faster, the way real ones do.
      node.angle += dt * 0.22 * cfg.speed * (this.maxRadius / Math.max(node.r, 1));
      node.r += (node.targetR - node.r) * Math.min(1, dt * 2.2);
      node.flash = Math.max(0, node.flash - dt * 1.5);
      for (const p of node.pulses) p.t += dt;
      node.pulses = node.pulses.filter((p) => p.t < 1.2);
    }
  }

  draw() {
    const ctx = this.ctx;
    const { w: W, h: H } = this;
    if (!W || !H) return;

    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;

    // --- starfield ---
    for (const s of this.stars) {
      const twinkle = 0.65 + Math.sin(this.t * 1.1 + s.phase) * 0.35;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(237,232,242,${(s.a * twinkle).toFixed(3)})`;
      ctx.fill();
    }

    // --- nebula wash behind the core ---
    const neb = ctx.createRadialGradient(cx, cy, 0, cx, cy, this.maxRadius * 1.15);
    neb.addColorStop(0, rgba(VIOLET_RGB, 0.07));
    neb.addColorStop(0.55, rgba(CORE_RGB, 0.025));
    neb.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, W, H);

    // --- orbit rings ---
    for (const key of ["active", "cooling", "dead"]) {
      const r = this.maxRadius * STATE[key].radius;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(STATE[key].rgb, 0.09);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const nodes = [...this.nodes.values()];

    // --- orbs and their trails ---
    for (const node of nodes) {
      const cfg = STATE[node.state] ?? STATE.dead;
      const x = cx + Math.cos(node.angle) * node.r;
      const y = cy + Math.sin(node.angle) * node.r;
      node.x = x;
      node.y = y;

      // Trailing arc along the orbit, fading behind the orb.
      ctx.beginPath();
      ctx.arc(cx, cy, node.r, node.angle - 0.42, node.angle);
      const trail = ctx.createLinearGradient(
        cx + Math.cos(node.angle - 0.42) * node.r,
        cy + Math.sin(node.angle - 0.42) * node.r,
        x,
        y,
      );
      trail.addColorStop(0, rgba(cfg.rgb, 0));
      trail.addColorStop(1, rgba(cfg.rgb, node.state === "dead" ? 0.12 : 0.3));
      ctx.strokeStyle = trail;
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // Pulse travelling inward to the core.
      for (const p of node.pulses) {
        const k = Math.min(1, p.t / 0.9);
        const px = x + (cx - x) * k;
        const py = y + (cy - y) * k;
        const tone = p.tone === "bad" ? STATE.dead.rgb : p.tone === "warn" ? STATE.cooling.rgb : cfg.rgb;
        const g = ctx.createRadialGradient(px, py, 0, px, py, 7);
        g.addColorStop(0, rgba(tone, (1 - k) * 0.9));
        g.addColorStop(1, rgba(tone, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      const focused = this.hovered === node;
      const size = node.size + (focused ? 1.6 : 0) + node.flash * 1.4;

      // Bloom.
      const bloom = ctx.createRadialGradient(x, y, 0, x, y, size * 5);
      bloom.addColorStop(0, rgba(cfg.rgb, node.state === "dead" ? 0.16 : 0.34 + node.flash * 0.3));
      bloom.addColorStop(0.45, rgba(cfg.rgb, 0.07));
      bloom.addColorStop(1, rgba(cfg.rgb, 0));
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(x, y, size * 5, 0, Math.PI * 2);
      ctx.fill();

      // Orb core with a light offset so it reads spherical, not flat.
      const body = ctx.createRadialGradient(x - size * 0.3, y - size * 0.3, 0, x, y, size);
      body.addColorStop(0, rgba(cfg.rgb, node.state === "dead" ? 0.6 : 1));
      body.addColorStop(1, rgba(cfg.rgb, node.state === "dead" ? 0.25 : 0.62));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();

      if (focused) {
        ctx.beginPath();
        ctx.arc(x, y, size + 5, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(VIOLET_RGB, 0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (node.cred) {
        ctx.font = "500 10.5px 'Segoe UI', system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = focused ? "rgba(237,232,242,0.95)" : "rgba(181,168,194,0.62)";
        ctx.fillText(node.cred.name, x, y + size + 11);
      }
    }

    // --- core, drawn last so it sits above the orbs ---
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, 62);
    halo.addColorStop(0, rgba(CORE_RGB, 0.34));
    halo.addColorStop(1, rgba(CORE_RGB, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, 62, 0, Math.PI * 2);
    ctx.fill();

    const pulse = 1 + Math.sin(this.t * 1.4) * 0.05;
    const core = ctx.createRadialGradient(cx - 4, cy - 4, 0, cx, cy, 15 * pulse);
    core.addColorStop(0, "rgba(255,214,150,1)");
    core.addColorStop(1, rgba(CORE_RGB, 0.75));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, 15 * pulse, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, 24 + Math.sin(this.t * 1.4) * 2, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(CORE_RGB, 0.22);
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = "600 9.5px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(181,168,194,0.75)";
    ctx.fillText("GATEWAY", cx, cy + 40);
  }

  frame(nowMs) {
    if (!this.alive) return;
    // rAF is paused while the tab is hidden, so the first frame back can carry
    // a stale canvas size from a resize we never saw.
    if (this.canvas.clientWidth !== this.cssW || this.canvas.clientHeight !== this.cssH) {
      this.resize();
    }
    const dt = nowMs - this.last;
    this.last = nowMs;
    this.step(dt);
    this.draw();
    requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------ pointer

  nodeAt(x, y) {
    for (const node of this.nodes.values()) {
      if (Math.hypot(node.x - x, node.y - y) <= node.size + 9) return node;
    }
    return null;
  }

  bindPointer() {
    this.canvas.addEventListener("pointermove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this.nodeAt(x, y);
      this.hovered = hit;
      this.canvas.style.cursor = hit ? "pointer" : "default";
      this.renderTooltip(hit, x, y);
    });

    this.canvas.addEventListener("pointerleave", () => {
      this.hovered = null;
      this.renderTooltip(null);
    });

    this.canvas.addEventListener("click", () => {
      if (this.hovered?.cred && this.onSelect) this.onSelect(this.hovered.cred);
    });
  }

  focusById(id) {
    this.hovered = id === null ? null : (this.nodes.get(id) ?? null);
  }

  renderTooltip(node, x = 0, y = 0) {
    const el = this.tooltip;
    if (!el) return;
    if (!node?.cred) {
      el.hidden = true;
      return;
    }
    const c = node.cred;
    const rel = (ts) => {
      if (!ts) return "—";
      const d = ts - Math.floor(Date.now() / 1000);
      const a = Math.abs(d);
      const u = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
      return d >= 0 ? `in ${u}` : `${u} ago`;
    };
    const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

    el.innerHTML =
      `<div class="tt-title">${esc(c.name)}</div>` +
      `<div class="tt-row"><span>state</span><span>${c.effectiveState}</span></div>` +
      `<div class="tt-row"><span>plan</span><span>${esc(c.planType ?? "unknown")}</span></div>` +
      `<div class="tt-row"><span>requests</span><span>${c.requestCount}</span></div>` +
      (c.resetsAt ? `<div class="tt-row"><span>resets</span><span>${rel(c.resetsAt)}</span></div>` : "") +
      (c.lastError ? `<div class="tt-row"><span>error</span><span>${esc(c.lastError)}</span></div>` : "");

    el.hidden = false;
    const pad = 12;
    el.style.left = `${Math.min(this.w - el.offsetWidth - pad, Math.max(pad, x + 14))}px`;
    el.style.top = `${Math.min(this.h - el.offsetHeight - pad, Math.max(pad, y + 14))}px`;
  }
}
