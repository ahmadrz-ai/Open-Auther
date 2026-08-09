/*
 * Dashboard shell: key handling, hash routing, and the live status stream.
 */

import { $, KEY_STORAGE, esc, get, state, toast } from "./core.js";
import { icon } from "./icons.js";
import * as pool from "./pages-pool.js";
import * as ops from "./pages-ops.js";
import { chat as chatPage } from "./pages-chat.js";
import { addProvider } from "./pages-providers.js";

/* ------------------------------------------------------------------ nav */

const NAV = [
  { group: "Gateway" },
  { id: "home", icon: "home", label: "Home", page: pool.home },
  { id: "chat", icon: "chat", label: "Chat", page: chatPage },
  { id: "client", icon: "link", label: "Point Your Client", page: pool.client },
  { id: "keys", icon: "key", label: "API Keys", page: pool.keys },

  { group: "Providers & Connections" },
  { id: "auths", icon: "hub", label: "Connections", page: pool.auths, badge: "auths" },
  { id: "add", icon: "personAdd", label: "Add Provider", page: addProvider },

  { group: "Compression" },
  { id: "caveman", icon: "compress", label: "Caveman", page: ops.caveman },

  { group: "Observability" },
  { id: "monitor", icon: "monitor", label: "Monitor", page: ops.monitor },
  { id: "logs", icon: "logs", label: "Logs", page: ops.logs },
  { id: "health", icon: "health", label: "Health", page: ops.health, badge: "health" },
  { id: "runtime", icon: "runtime", label: "Runtime", page: ops.runtime },

  { group: "Configuration" },
  { id: "settings", icon: "settings", label: "Settings", page: ops.settings },
  { id: "about", icon: "spark", label: "About", page: ops.about },
];

const ROUTES = Object.fromEntries(NAV.filter((n) => n.id).map((n) => [n.id, n]));

/* ------------------------------------------------------------------ key */

function readKeyFromHash() {
  // The CLI prints a dashboard link with `#key=...`. Fragments never reach the
  // server, so this is the one safe channel for handing the key to the page.
  const raw = location.hash.slice(1);
  if (!raw.includes("key=")) return null;
  const found = new URLSearchParams(raw).get("key");
  if (found) {
    localStorage.setItem(KEY_STORAGE, found);
    history.replaceState(null, "", `${location.pathname}#/home`);
  }
  return found;
}

state.key = readKeyFromHash() ?? localStorage.getItem(KEY_STORAGE);

function showGate(message) {
  $("app").hidden = true;
  $("gate").hidden = false;
  const err = $("gate-error");
  err.hidden = !message;
  if (message) err.textContent = message;
  $("gate-key").focus();
}

state.onUnauthorized = () => showGate("That key was rejected.");

$("gate-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("gate-key").value.trim();
  if (!value) return;
  localStorage.setItem(KEY_STORAGE, value);
  state.key = value;
  $("gate").hidden = true;
  $("app").hidden = false;
  boot();
});

/* ------------------------------------------------------------- app state */

const ctx = {
  status: null,
  events: [],
  graph: null,
  setGraph(g) {
    ctx.graph = g;
  },
  nameFor(id) {
    return ctx.status?.credentials.find((c) => c.id === id)?.name ?? `Auth ${id}`;
  },
  async refresh() {
    try {
      ctx.status = await get("/admin/status");
      applyStatus();
    } catch {
      /* the stream will re-sync */
    }
  },
};

let active = null;
let activeId = null;

/* --------------------------------------------------------------- render */

function renderNav() {
  $("rail-nav").innerHTML = NAV.map((n) => {
    if (n.group) return `<div class="nav-group">${esc(n.group)}</div>`;
    return `<a class="nav-item" data-route="${n.id}" href="#/${n.id}">
      ${icon(n.icon, 18)}<span>${esc(n.label)}</span>
      ${n.badge ? `<span class="nav-badge" data-badge="${n.badge}" hidden></span>` : ""}
    </a>`;
  }).join("");
}

function applyStatus() {
  const s = ctx.status;
  if (!s) return;

  $("pills").innerHTML = `
    <span class="pill ok"><i></i><b>${s.summary.active}</b> active</span>
    <span class="pill warn"><i></i><b>${s.summary.cooling}</b> cooling</span>
    <span class="pill bad"><i></i><b>${s.summary.dead}</b> dead</span>`;

  const authBadge = document.querySelector('[data-badge="auths"]');
  if (authBadge) {
    authBadge.hidden = s.summary.total === 0;
    authBadge.textContent = s.summary.total;
  }

  const healthBadge = document.querySelector('[data-badge="health"]');
  if (healthBadge) {
    const bad = s.summary.dead + (s.summary.active === 0 && s.summary.total > 0 ? 1 : 0);
    healthBadge.hidden = bad === 0;
    healthBadge.className = "nav-badge bad";
    healthBadge.textContent = s.summary.dead || "!";
  }

  active?.onStatus?.();
}

function navigate() {
  const id = (location.hash.replace(/^#\//, "").split("?")[0] || "home");
  const route = ROUTES[id] ?? ROUTES.home;

  if (activeId === route.id && id.includes("?") === false && active) {
    // Same page, different query (e.g. ?focus=) — remount so it picks it up.
  }

  active?.destroy?.();
  active = null;
  activeId = route.id;

  document.querySelectorAll(".nav-item").forEach((el) =>
    el.classList.toggle("active", el.dataset.route === route.id),
  );

  $("page-title").textContent = route.page.title;
  $("page-sub").textContent = route.page.subtitle;

  const main = $("main");
  main.scrollTop = 0;

  // Each page gets a fresh container rather than reusing #main. Pages attach
  // delegated click handlers to their host, and #main survives navigation —
  // so reusing it accumulated a listener per visit, and stale handlers kept
  // writing into the live DOM using their own captured state.
  const host = document.createElement("div");
  host.className = "page-host";
  main.replaceChildren(host);

  try {
    active = route.page.mount(host, ctx) ?? {};
  } catch (err) {
    host.innerHTML = `<div class="page"><div class="note bad">${icon("error", 16)}<span>${esc(err.message)}</span></div></div>`;
  }
}

window.addEventListener("hashchange", navigate);

/* --------------------------------------------------------------- stream */

let retry = 1000;

function setConn(stateName, label) {
  const el = $("conn");
  el.dataset.state = stateName;
  el.querySelector("span").textContent = label;
}

async function connect() {
  setConn("connecting", "connecting");

  let res;
  try {
    res = await fetch("/admin/stream", {
      headers: { authorization: `Bearer ${state.key}`, accept: "text/event-stream" },
    });
  } catch {
    setConn("lost", "offline");
    return void setTimeout(connect, (retry = Math.min(retry * 1.7, 15000)));
  }

  if (res.status === 401) {
    localStorage.removeItem(KEY_STORAGE);
    state.key = null;
    return showGate("That key was rejected. Check the key the server printed.");
  }
  if (!res.ok || !res.body) {
    setConn("lost", "error");
    return void setTimeout(connect, (retry = Math.min(retry * 1.7, 15000)));
  }

  setConn("live", "live");
  retry = 1000;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let name = "message";
        const data = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;

        let payload;
        try {
          payload = JSON.parse(data.join("\n"));
        } catch {
          continue;
        }

        if (name === "status") {
          ctx.status = payload;
          applyStatus();
        } else if (name === "event") {
          ctx.events.unshift(payload);
          if (ctx.events.length > 200) ctx.events.length = 200;
          active?.onEvent?.(payload);
        }
      }
    }
  } catch {
    /* falls through to reconnect */
  }

  setConn("lost", "reconnecting");
  setTimeout(connect, (retry = Math.min(retry * 1.7, 15000)));
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  renderNav();

  try {
    ctx.status = await get("/admin/status");
  } catch (err) {
    if (state.key) toast(err.message, "bad");
    return;
  }

  $("rail-version").textContent = `v${ctx.status.gateway.version}`;
  applyStatus();

  try {
    const { events } = await get("/admin/events");
    ctx.events = events;
  } catch {
    /* non-fatal */
  }

  if (!location.hash.startsWith("#/")) location.hash = "#/home";
  navigate();
  connect();
}

if (state.key) {
  $("app").hidden = false;
  boot();
} else {
  showGate();
}
