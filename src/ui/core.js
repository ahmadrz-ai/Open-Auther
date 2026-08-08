/*
 * Shared plumbing: authenticated fetch, formatting, toasts, modals.
 *
 * The admin API is authenticated with a bearer header, so the live stream is
 * read as SSE over fetch rather than with EventSource — EventSource cannot set
 * headers, and putting the key in a query string would leak it into every log
 * along the path.
 */

import { icon } from "./icons.js";

export const KEY_STORAGE = "ai-auther.key";

export const state = {
  key: null,
  status: null,
  /** Called when the key is rejected, so the shell can show the gate. */
  onUnauthorized: null,
};

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

// ------------------------------------------------------------------ fetch

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.key}`,
      ...(opts.headers ?? {}),
    },
  });

  if (res.status === 401) {
    localStorage.removeItem(KEY_STORAGE);
    state.key = null;
    state.onUnauthorized?.();
    throw new Error("Unauthorized");
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    // Keep the parsed body on the error. Some endpoints return structured
    // diagnostics alongside the message (endpoint detection attaches every
    // candidate it tried) and throwing a bare string discards all of it.
    const err = new Error(body?.error?.message ?? `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.body = body;
    if (body?.detection) err.detection = body.detection;
    throw err;
  }
  return body;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: "POST", body: JSON.stringify(body ?? {}) });
export const del = (p) => api(p, { method: "DELETE" });

// -------------------------------------------------------------- formatting

const nf = new Intl.NumberFormat();
export const num = (n) => nf.format(n ?? 0);

export function compact(n) {
  n = Number(n ?? 0);
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + "M";
  return (n / 1_000_000_000).toFixed(1) + "B";
}

export function relative(epochSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!epochSeconds) return "—";
  const d = epochSeconds - nowSeconds;
  const a = Math.abs(d);
  const u =
    a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return d >= 0 ? `in ${u}` : `${u} ago`;
}

export function clock(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function dateTime(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function duration(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function bytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n ?? 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ------------------------------------------------------------------ toasts

export function toast(message, kind = "ok") {
  const host = $("toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "bad" ? "error" : "check", 16)}<span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .25s ease";
    setTimeout(() => el.remove(), 260);
  }, kind === "bad" ? 6000 : 3200);
}

export async function copy(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    // Clipboard is blocked outside secure contexts on some setups; a manual
    // selection fallback beats a silent no-op.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(label);
    } catch {
      toast("Could not copy — select the text manually.", "bad");
    }
    ta.remove();
  }
}

// ------------------------------------------------------------------ modal

/**
 * Open a modal. `render` returns HTML for the body; `onMount` receives the
 * modal root so handlers can be wired. Resolves when the modal closes.
 */
export function modal({ title, body, footer, onMount, width }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" ${width ? `style="width:min(${width},100%)"` : ""}>
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="btn-icon" data-close aria-label="Close">${icon("close", 18)}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
      </div>`;

    const close = (value) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
    };

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop || e.target.closest("[data-close]")) close(null);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);

    backdrop.querySelector("input, select, textarea, button:not([data-close])")?.focus();
    onMount?.(backdrop, close);
  });
}

export function confirmDialog(title, message, confirmLabel = "Confirm") {
  return modal({
    title,
    body: `<p style="margin:0;color:var(--text-dim)">${esc(message)}</p>`,
    footer:
      `<button data-close>Cancel</button>` +
      `<button class="btn-primary" data-confirm>${esc(confirmLabel)}</button>`,
    onMount: (root, close) => {
      root.querySelector("[data-confirm]").addEventListener("click", () => close(true));
    },
  });
}

// ----------------------------------------------------------- small helpers

export const stateTag = (s) =>
  `<span class="tag ${esc(s)}"><i></i>${esc(s)}</span>`;

export function emptyRow(colspan, message) {
  return `<tr><td colspan="${colspan}"><div class="empty">${esc(message)}</div></td></tr>`;
}

export function card(title, iconName, inner, actions = "", sub = "") {
  return `
    <section class="card">
      <div class="card-head">
        <div class="card-head-text">
          <h2>${icon(iconName, 17)} ${esc(title)}</h2>
          ${sub ? `<p class="sub">${esc(sub)}</p>` : ""}
        </div>
        ${actions ? `<div class="pills">${actions}</div>` : ""}
      </div>
      ${inner}
    </section>`;
}
