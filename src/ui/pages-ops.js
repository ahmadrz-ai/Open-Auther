/* Pages: Monitor, Logs, Health, Runtime, Caveman, Settings. */

import {
  bytes, card, clock, compact, confirmDialog, dateTime, del, duration, emptyRow, esc, get, num,
  post, relative, toast,
} from "./core.js";
import { icon } from "./icons.js";

/* --------------------------------------------------------------- monitor */

export const monitor = {
  title: "Monitor",
  subtitle: "Usage, cost of compression, and where traffic went",

  mount(host) {
    host.innerHTML = `<div class="page">
      <div class="pills">
        ${[1, 6, 24, 168].map((h) => `<button class="btn-sm" data-hours="${h}">${h === 168 ? "7 days" : `${h}h`}</button>`).join("")}
      </div>
      <div class="grid-4" id="mon-stats"></div>
      <div id="mon-chart"></div>
      <div class="grid-2" id="mon-tables"></div>
    </div>`;

    let hours = 24;

    const render = async () => {
      let s;
      try {
        s = await get(`/admin/stats?hours=${hours}`);
      } catch (err) {
        return toast(err.message, "bad");
      }

      host.querySelectorAll("[data-hours]").forEach((b) =>
        b.classList.toggle("btn-primary", Number(b.dataset.hours) === hours),
      );

      const errRate = s.requests ? (s.errors / s.requests) * 100 : 0;

      host.querySelector("#mon-stats").innerHTML = `
        <div class="stat"><div class="stat-value">${num(s.requests)}</div><div class="stat-label">Requests</div></div>
        <div class="stat ${s.errors ? "bad" : "ok"}"><div class="stat-value">${num(s.errors)}</div>
          <div class="stat-label">Errors</div><div class="stat-note">${errRate.toFixed(1)}% of traffic</div></div>
        <div class="stat accent"><div class="stat-value">${compact(s.tokens)}</div><div class="stat-label">Tokens</div></div>
        <div class="stat"><div class="stat-value">${num(s.avgLatencyMs)}<span style="font-size:12px;color:var(--text-faint)">ms</span></div>
          <div class="stat-label">Avg latency</div></div>`;

      const peak = Math.max(1, ...s.byHour.map((h) => h.requests));
      host.querySelector("#mon-chart").innerHTML = card(
        "Traffic", "monitor",
        s.byHour.length
          ? `<div class="bars">${s.byHour.map((h) => {
              const pct = (h.requests / peak) * 100;
              const errPct = h.requests ? (h.errors / h.requests) * 100 : 0;
              return `<div class="bar hasdata" style="height:${Math.max(2, pct)}%"
                        title="${dateTime(h.hour)} · ${h.requests} requests, ${h.errors} errors">
                        ${h.errors ? `<i style="height:${errPct}%"></i>` : ""}</div>`;
            }).join("")}</div>
            <div class="bar-axis"><span>${esc(dateTime(s.byHour[0].hour))}</span><span>now</span></div>`
          : `<div class="empty">No requests in this window.</div>`,
        "", "Bar height is request volume; the red foot is errors.",
      );

      const savedPct = s.inputTokensSaved && s.tokens ? (s.inputTokensSaved / (s.tokens + s.inputTokensSaved)) * 100 : 0;

      host.querySelector("#mon-tables").innerHTML =
        card("By Auth", "hub",
          `<div class="table-wrap"><table>
            <thead><tr><th>Auth</th><th style="text-align:right">Requests</th><th style="text-align:right">Tokens</th></tr></thead>
            <tbody>${s.byCredential.length
              ? s.byCredential.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${num(r.requests)}</td><td class="num">${compact(r.tokens)}</td></tr>`).join("")
              : emptyRow(3, "No traffic yet.")}</tbody>
          </table></div>`) +
        card("Caveman compression", "compress",
          `<div class="grid-3" style="margin-bottom:12px">
            <div class="stat"><div class="stat-value">${num(s.compressedRequests)}</div><div class="stat-label">Compressed</div></div>
            <div class="stat ok"><div class="stat-value">${compact(s.inputTokensSaved)}</div>
              <div class="stat-label">Input saved</div><div class="stat-note">${savedPct.toFixed(1)}% of input</div></div>
            <div class="stat"><div class="stat-value">${compact(s.outputWouldSave)}</div>
              <div class="stat-label">Output (measured)</div></div>
          </div>
          <div class="note">${icon("warning", 16)}
            <span>Input compression is real and applied. Output is
            <b>measured only</b> — the number above is what compressing responses
            <i>would</i> have saved. Nothing you receive is ever altered.</span></div>`) +
        card("By model", "bolt",
          `<div class="table-wrap"><table>
            <thead><tr><th>Model</th><th style="text-align:right">Requests</th><th style="text-align:right">Tokens</th></tr></thead>
            <tbody>${s.byModel.length
              ? s.byModel.map((r) => `<tr><td class="mono">${esc(r.model)}</td><td class="num">${num(r.requests)}</td><td class="num">${compact(r.tokens)}</td></tr>`).join("")
              : emptyRow(3, "No traffic yet.")}</tbody>
          </table></div>`);
    };

    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-hours]");
      if (!b) return;
      hours = Number(b.dataset.hours);
      render();
    });

    render();
    const timer = setInterval(render, 20000);
    return { destroy: () => clearInterval(timer) };
  },
};

/* ------------------------------------------------------------------ logs */

export const logs = {
  title: "Logs",
  subtitle: "Every request routed through the gateway",

  mount(host) {
    host.innerHTML = `<div class="page">
      ${card("Request log", "logs",
        `<div class="table-wrap"><table>
          <thead><tr>
            <th>Time</th><th>Auth</th><th>Client</th><th>Model</th><th>Result</th>
            <th style="text-align:right">Tries</th><th style="text-align:right">Tokens</th>
            <th style="text-align:right">Latency</th><th>Compression</th><th>Error</th>
          </tr></thead>
          <tbody id="log-rows"></tbody>
        </table></div>`,
        `<select id="log-filter" style="width:auto;padding:5px 9px;font-size:11.5px">
           <option value="">All outcomes</option>
           <option value="ok">Success</option>
           <option value="rotated_ok">Rotated then succeeded</option>
           <option value="error">Errors</option>
         </select>
         <button class="btn-sm" id="log-refresh">${icon("refresh", 15)}</button>`)}
    </div>`;

    let outcome = "";

    const render = async () => {
      let data;
      try {
        data = await get(`/admin/logs?limit=300${outcome ? `&outcome=${outcome}` : ""}`);
      } catch (err) {
        return toast(err.message, "bad");
      }

      host.querySelector("#log-rows").innerHTML = data.logs.length
        ? data.logs.map((l) => {
            const ratio = l.compressed && l.inputBefore
              ? `${Math.round((1 - l.inputAfter / l.inputBefore) * 100)}% smaller`
              : "—";
            return `<tr>
              <td class="mono" title="${esc(dateTime(l.ts))}">${esc(clock(l.ts))}</td>
              <td>${esc(l.credentialName ?? "—")}</td>
              <td>${esc(l.client ?? "—")}</td>
              <td class="mono">${esc(l.model ?? "—")}</td>
              <td><span class="tag ${esc(l.outcome)}">${esc(l.outcome === "rotated_ok" ? "rotated" : l.outcome)}</span>${l.streaming ? ' <span class="tag">stream</span>' : ""}</td>
              <td class="num">${l.attempts}</td>
              <td class="num">${compact(l.totalTokens)}</td>
              <td class="num">${l.latencyMs === null ? "—" : `${num(l.latencyMs)}ms`}</td>
              <td class="mono" style="color:${l.compressed ? "var(--ok)" : "var(--text-faint)"}">${esc(ratio)}</td>
              <td class="mono" style="color:var(--bad)">${esc(l.errorCode ?? "")}</td>
            </tr>`;
          }).join("")
        : emptyRow(10, "No requests logged yet. Send one through the gateway and it appears here.");
    };

    host.querySelector("#log-filter").addEventListener("change", (e) => {
      outcome = e.target.value;
      render();
    });
    host.querySelector("#log-refresh").addEventListener("click", render);

    render();
    const timer = setInterval(render, 10000);
    return { destroy: () => clearInterval(timer) };
  },
};

/* ---------------------------------------------------------------- health */

export const health = {
  title: "Health",
  subtitle: "Gateway and per-Auth condition",

  mount(host) {
    host.innerHTML = `<div class="page" id="health-body"></div>`;

    const render = async () => {
      let h;
      try {
        h = await get("/admin/health/detail");
      } catch (err) {
        return toast(err.message, "bad");
      }

      const statusText = {
        ok: ["ok", "Routing normally."],
        exhausted: ["bad", "Every Auth is rate limited or dead. Requests are returning 429."],
        no_credentials: ["warn", "No Auths connected, so nothing can be routed."],
      }[h.gateway.status] ?? ["warn", h.gateway.status];

      const errPct = (h.gateway.errorRate * 100).toFixed(1);

      host.querySelector("#health-body").innerHTML = `
        <div class="note ${statusText[0]}">
          ${icon(statusText[0] === "ok" ? "check" : statusText[0] === "bad" ? "error" : "warning", 16)}
          <span><b>Gateway ${esc(h.gateway.status)}.</b> ${esc(statusText[1])}</span>
        </div>

        <div class="grid-3">
          <div class="stat"><div class="stat-value">${errPct}%</div>
            <div class="stat-label">Error rate</div>
            <div class="stat-note">last ${h.gateway.sampleSize} requests</div></div>
          <div class="stat ${h.caveman.enabled ? "ok" : ""}">
            <div class="stat-value" style="font-size:15px">${h.caveman.enabled ? "Enabled" : "Off"}</div>
            <div class="stat-label">Caveman</div>
            <div class="stat-note">${h.caveman.configured ? esc(h.caveman.model ?? "") : "not configured"}</div></div>
          <div class="stat"><div class="stat-value">${h.credentials.filter((c) => c.state === "active").length}/${h.credentials.length}</div>
            <div class="stat-label">Auths available</div></div>
        </div>

        ${card("Per-Auth health", "health",
          `<div class="table-wrap"><table>
            <thead><tr>
              <th>Auth</th><th>State</th><th>Token</th>
              <th style="text-align:right">Success</th><th style="text-align:right">Errors</th>
              <th style="text-align:right">Reliability</th><th>Recovers</th><th>Last used</th><th>Last error</th>
            </tr></thead>
            <tbody>${h.credentials.length
              ? h.credentials.map((c) => {
                  const total = c.successCount + c.errorCount;
                  const rel = total ? (c.successCount / total) * 100 : 100;
                  return `<tr>
                    <td style="font-weight:500">${esc(c.name)}</td>
                    <td><span class="tag ${esc(c.state)}"><i></i>${esc(c.state)}</span></td>
                    <td>${c.needsRefresh ? '<span class="tag cooling"><i></i>stale</span>' : '<span class="tag active"><i></i>fresh</span>'}</td>
                    <td class="num">${num(c.successCount)}</td>
                    <td class="num">${num(c.errorCount)}</td>
                    <td style="min-width:110px">
                      <div class="meter ${rel > 90 ? "ok" : rel > 60 ? "" : "bad"}"><i style="width:${rel}%"></i></div>
                      <div style="font-size:10.5px;color:var(--text-faint);text-align:right">${rel.toFixed(0)}%</div>
                    </td>
                    <td class="mono">${esc(relative(c.resetsAt ?? c.cooldownUntil, h.now))}</td>
                    <td class="mono">${esc(relative(c.lastUsedAt, h.now))}</td>
                    <td class="mono" style="color:var(--bad)">${esc(c.lastError ?? "—")}</td>
                  </tr>`;
                }).join("")
              : emptyRow(9, "No Auths connected.")}</tbody>
          </table></div>`)}`;
    };

    render();
    const timer = setInterval(render, 8000);
    return { destroy: () => clearInterval(timer) };
  },
};

/* --------------------------------------------------------------- runtime */

export const runtime = {
  title: "Runtime",
  subtitle: "Process, paths and resource use",

  mount(host) {
    host.innerHTML = `<div class="page" id="rt-body"></div>`;

    const row = (k, v, mono = true) =>
      `<tr><td style="color:var(--text-dim);width:40%">${esc(k)}</td><td class="${mono ? "mono" : ""}">${esc(v)}</td></tr>`;

    const render = async () => {
      let r;
      try {
        r = await get("/admin/runtime");
      } catch (err) {
        return toast(err.message, "bad");
      }

      const heapPct = (r.memory.heapUsedBytes / r.memory.heapTotalBytes) * 100;
      const sysPct = ((r.memory.systemTotalBytes - r.memory.systemFreeBytes) / r.memory.systemTotalBytes) * 100;

      host.querySelector("#rt-body").innerHTML = `
        <div class="grid-4">
          <div class="stat accent"><div class="stat-value" style="font-size:16px">${esc(duration(r.uptimeSeconds))}</div><div class="stat-label">Uptime</div></div>
          <div class="stat"><div class="stat-value" style="font-size:16px">${esc(r.version)}</div><div class="stat-label">Version</div></div>
          <div class="stat"><div class="stat-value" style="font-size:16px">${esc(bytes(r.memory.rssBytes))}</div><div class="stat-label">Memory (RSS)</div></div>
          <div class="stat"><div class="stat-value" style="font-size:16px">${esc(r.node)}</div><div class="stat-label">Node</div></div>
        </div>

        ${card("Process", "runtime",
          `<div class="table-wrap"><table><tbody>
            ${row("PID", r.pid)}
            ${row("Platform", r.platform)}
            ${row("Host", r.host)}
            ${row("CPU cores", r.cpus)}
            ${row("Listening on", `${r.listening.host}:${r.listening.port}`)}
          </tbody></table></div>`)}

        ${card("Memory", "monitor", `
          <div class="field" style="margin-bottom:12px">
            <label>Heap ${esc(bytes(r.memory.heapUsedBytes))} of ${esc(bytes(r.memory.heapTotalBytes))}</label>
            <div class="meter ${heapPct > 85 ? "bad" : "ok"}"><i style="width:${heapPct}%"></i></div>
          </div>
          <div class="field">
            <label>System ${esc(bytes(r.memory.systemTotalBytes - r.memory.systemFreeBytes))} of ${esc(bytes(r.memory.systemTotalBytes))}</label>
            <div class="meter ${sysPct > 90 ? "bad" : ""}"><i style="width:${sysPct}%"></i></div>
          </div>`)}

        ${card("Paths", "cloud",
          `<div class="table-wrap"><table><tbody>
            ${row("Data directory", r.paths.home)}
            ${row("Database", r.paths.database)}
            ${row("Config", r.paths.config)}
          </tbody></table></div>
          <div class="note bad" style="margin-top:12px">${icon("shield", 16)}
            <span>The database holds live OAuth access and refresh tokens. Treat it
            like an SSH private key — do not sync it to shared storage or attach it
            to a bug report.</span></div>`)}`;
    };

    render();
    const timer = setInterval(render, 5000);
    return { destroy: () => clearInterval(timer) };
  },
};

/* --------------------------------------------------------------- caveman */

export const caveman = {
  title: "Caveman",
  subtitle: "Prompt compression through your own summarising model",

  mount(host) {
    /*
     * Two columns: settings on the left, an activity panel on the right with
     * History and Logs as tabs. History is every compression attempt with both
     * sides of the exchange; Logs is the failures pulled out on their own.
     */
    host.innerHTML = `
      <div class="cv-layout">
        <div class="page" id="cv-body"><div class="empty">Loading…</div></div>
        <aside class="cv-side">
          <div class="cv-tabs">
            <button class="cv-tab active" data-cvtab="history">History</button>
            <button class="cv-tab" data-cvtab="logs">Logs</button>
            <button class="btn-sm cv-tab-action" id="cv-refresh" title="Refresh">${icon("refresh", 14)}</button>
            <button class="btn-sm cv-tab-action btn-danger" id="cv-clear" title="Clear history">${icon("trash", 14)}</button>
          </div>
          <div class="cv-stats" id="cv-stats"></div>
          <div class="cv-feed" id="cv-feed"><div class="empty">Loading…</div></div>
        </aside>
      </div>`;

    let tab = "history";

    const OUTCOME_TONE = {
      compressed: "ok",
      no_gain: "warn",
      skipped: "warn",
      failed: "bad",
    };

    const entryCard = (e) => {
      const saved = e.beforeTokens - e.afterTokens;
      const pct = e.beforeTokens ? Math.round((saved / e.beforeTokens) * 100) : 0;
      return `
        <details class="cv-entry ${OUTCOME_TONE[e.outcome] ?? ""}">
          <summary>
            <span class="cv-entry-outcome">${esc(e.outcome)}</span>
            <span class="cv-entry-nums">
              ${e.outcome === "compressed"
                ? `${compact(e.beforeTokens)} → ${compact(e.afterTokens)} (${pct}% smaller)`
                : `${compact(e.beforeTokens)} tokens`}
            </span>
            <span class="cv-entry-time">${esc(clock(e.ts))}</span>
          </summary>
          <div class="cv-entry-body">
            ${e.error ? `<div class="cv-entry-error">${icon("warning", 13)} ${esc(e.error)}</div>` : ""}
            <div class="cv-entry-meta">
              ${esc(e.model ?? "—")} · ${e.latencyMs ?? "—"}ms
            </div>
            <div class="cv-entry-label">Input to Caveman</div>
            <pre class="cv-entry-text">${esc(e.inputText ?? "—")}</pre>
            <div class="cv-entry-label">Output from Caveman</div>
            <pre class="cv-entry-text">${esc(e.outputText ?? "—")}</pre>
          </div>
        </details>`;
    };

    const loadFeed = async () => {
      const feed = host.querySelector("#cv-feed");
      try {
        const q = tab === "logs" ? "?outcome=failed&limit=100" : "?limit=100";
        const data = await get(`/admin/caveman/history${q}`);

        host.querySelector("#cv-stats").innerHTML = `
          <span class="cv-stat"><b>${data.stats.total}</b> runs</span>
          <span class="cv-stat ok"><b>${data.stats.compressed}</b> compressed</span>
          <span class="cv-stat bad"><b>${data.stats.failed}</b> failed</span>
          <span class="cv-stat"><b>${compact(data.stats.tokensSaved)}</b> saved</span>`;

        feed.innerHTML = data.entries.length
          ? data.entries.map(entryCard).join("")
          : `<div class="empty">${tab === "logs"
              ? "No failures recorded."
              : "Nothing yet. Send a prompt over the minimum size with compression enabled."}</div>`;
      } catch (err) {
        feed.innerHTML = `<div class="note bad">${icon("error", 15)}<span>${esc(err.message)}</span></div>`;
      }
    };

    host.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-cvtab]");
      if (t) {
        tab = t.dataset.cvtab;
        host.querySelectorAll("[data-cvtab]").forEach((b) =>
          b.classList.toggle("active", b.dataset.cvtab === tab),
        );
        return void loadFeed();
      }
      if (e.target.closest("#cv-refresh")) return void loadFeed();
      if (e.target.closest("#cv-clear")) {
        const ok = await confirmDialog("Clear history", "Remove every recorded run.", "Clear");
        if (!ok) return;
        await del("/admin/caveman/history");
        loadFeed();
      }
    });

    const feedTimer = setInterval(loadFeed, 15000);
    loadFeed();

    const render = async () => {
      let c;
      try {
        c = await get("/admin/caveman");
      } catch (err) {
        return toast(err.message, "bad");
      }

      host.querySelector("#cv-body").innerHTML = `
        <div class="note">${icon("compress", 16)}
          <span>Caveman summarises the older middle of a conversation before it is
          forwarded, using a model <b>you</b> supply. It deliberately does not use the
          Auth pool — compressing through the pool would spend the very quota
          compression exists to conserve.</span></div>

        ${card("Connection", "link", `
          <div class="form">
            <label class="switch">
              <input type="checkbox" id="cv-enabled" ${c.enabled ? "checked" : ""} />
              <span class="switch-track"></span>
              <span>Enable compression</span>
            </label>

            <div class="field">
              <label>Base URL</label>
              <input id="cv-base" value="${esc(c.baseUrl)}" placeholder="https://api.groq.com/openai/v1" />
              <span class="help">Any OpenAI-compatible endpoint. Include the version path.</span>
            </div>

            <div class="field">
              <label>API key</label>
              <input id="cv-key" type="password" placeholder="${c.apiKeySet ? "•••••••• (leave blank to keep)" : "Optional for local endpoints"}" />
              <span class="help">Sent as a bearer header, never in the URL. Never displayed back.</span>
            </div>

            <div class="field-row">
              <div class="field">
                <label>Model</label>
                <input id="cv-model" value="${esc(c.model)}" placeholder="llama-3.1-8b-instant" list="cv-models" />
                <datalist id="cv-models"></datalist>
              </div>
              <button class="btn-sm" id="cv-fetch">${icon("refresh", 15)} Fetch models</button>
            </div>

            <div style="display:flex;gap:8px;align-items:center">
              <button class="btn-primary" id="cv-save">${icon("check", 16)} Save</button>
              <button id="cv-test">${icon("play", 16)} Test connection</button>
              <span id="cv-test-out" style="font-size:12px;color:var(--text-faint)"></span>
            </div>
          </div>`)}

        ${card("Behaviour", "settings", `
          <div class="form">
            <div class="grid-2">
              <div class="field">
                <label>Minimum prompt size (tokens)</label>
                <input id="cv-min" type="number" min="0" value="${c.minTokens}" />
                <span class="help">Prompts smaller than this are forwarded untouched.</span>
              </div>
              <div class="field">
                <label>Target ratio</label>
                <input id="cv-ratio" type="number" min="0.05" max="0.95" step="0.05" value="${c.targetRatio}" />
                <span class="help">0.5 aims to halve the compressible part.</span>
              </div>
              <div class="field">
                <label>Keep recent messages verbatim</label>
                <input id="cv-keep" type="number" min="0" value="${c.keepRecentMessages}" />
                <span class="help">The newest turns are never rewritten.</span>
              </div>
              <div class="field">
                <label>Timeout (ms)</label>
                <input id="cv-timeout" type="number" min="1000" step="1000" value="${c.requestTimeoutMs}" />
              </div>
            </div>

            <label class="switch">
              <input type="checkbox" id="cv-code" ${c.preserveCode ? "checked" : ""} />
              <span class="switch-track"></span>
              <span>Never rewrite fenced code blocks</span>
            </label>

            <label class="switch">
              <input type="checkbox" id="cv-measure" ${c.measureOutput ? "checked" : ""} />
              <span class="switch-track"></span>
              <span>Measure output compression (measurement only, never alters responses)</span>
            </label>

            <div class="field">
              <label>Instruction sent to the summariser</label>
              <textarea id="cv-instruction">${esc(c.instruction)}</textarea>
            </div>

            <div><button class="btn-primary" id="cv-save2">${icon("check", 16)} Save behaviour</button></div>
          </div>`)}

        <div class="note warn">${icon("warning", 16)}
          <span>Compression can never break a request. If the summariser is slow,
          misconfigured or returns something longer than the original, ai-auther
          forwards the untouched prompt and records why.</span></div>`;

      const val = (id) => host.querySelector(id).value.trim();
      const collect = () => ({
        enabled: host.querySelector("#cv-enabled").checked,
        baseUrl: val("#cv-base"),
        model: val("#cv-model"),
        apiKey: val("#cv-key"),
        minTokens: Number(val("#cv-min")),
        targetRatio: Number(val("#cv-ratio")),
        keepRecentMessages: Number(val("#cv-keep")),
        requestTimeoutMs: Number(val("#cv-timeout")),
        preserveCode: host.querySelector("#cv-code").checked,
        measureOutput: host.querySelector("#cv-measure").checked,
        instruction: host.querySelector("#cv-instruction").value,
      });

      const save = async () => {
        try {
          await post("/admin/caveman", collect());
          toast("Caveman settings saved");
          render();
        } catch (err) {
          toast(err.message, "bad");
        }
      };

      host.querySelector("#cv-save").addEventListener("click", save);
      host.querySelector("#cv-save2").addEventListener("click", save);

      host.querySelector("#cv-test").addEventListener("click", async (e) => {
        const out = host.querySelector("#cv-test-out");
        e.currentTarget.disabled = true;
        out.textContent = "Testing…";
        try {
          const r = await post("/admin/caveman/test", collect());
          out.innerHTML = r.ok
            ? `<span style="color:var(--ok)">OK · ${r.latencyMs}ms</span>`
            : `<span style="color:var(--bad)">${esc(r.message)}</span>`;
        } catch (err) {
          out.innerHTML = `<span style="color:var(--bad)">${esc(err.message)}</span>`;
        } finally {
          e.currentTarget.disabled = false;
        }
      });

      host.querySelector("#cv-fetch").addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          const { models } = await post("/admin/caveman/models", collect());
          host.querySelector("#cv-models").innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join("");
          toast(models.length ? `${models.length} models available` : "Endpoint returned no model list", models.length ? "ok" : "bad");
        } catch (err) {
          toast(err.message, "bad");
        } finally {
          e.currentTarget.disabled = false;
        }
      });
    };

    render();
    return { destroy: () => clearInterval(feedTimer) };
  },
};

/* -------------------------------------------------------------- settings */

export const settings = {
  title: "Settings",
  subtitle: "Routing behaviour and gateway configuration",

  mount(host, ctx) {
    host.innerHTML = `<div class="page" id="set-body"><div class="empty">Loading…</div></div>`;

    const render = async () => {
      let s;
      try {
        s = await get("/admin/settings");
      } catch (err) {
        return toast(err.message, "bad");
      }

      const strategies = [
        ["fill_first", "Drain one Auth, then the next. Staggers reset dates so something is always coming back."],
        ["round_robin", "Even spread. Fair wear, but every Auth approaches exhaustion together."],
        ["least_used", "Fewest requests first. Good when Auths have unequal quotas."],
        ["random", "Uniform random. No state, no ordering guarantees."],
      ];

      host.querySelector("#set-body").innerHTML = `
        ${card("Rotation", "refresh", `
          <div class="form">
            <div class="field">
              <label>Strategy</label>
              <select id="s-rotation">
                ${strategies.map(([v]) => `<option value="${v}" ${s.rotation === v ? "selected" : ""}>${v}</option>`).join("")}
              </select>
              <span class="help" id="s-rot-help"></span>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>Max attempts per request</label>
                <input id="s-attempts" type="number" min="1" max="20" value="${s.maxAttempts}" />
                <span class="help">How many Auths one client request may try before giving up.</span>
              </div>
              <div class="field">
                <label>Fallback cooldown (seconds)</label>
                <input id="s-cooldown" type="number" min="0" value="${s.defaultCooldownSeconds}" />
                <span class="help">Only used when upstream gives no <code>resets_at</code>.</span>
              </div>
              <div class="field">
                <label>Refresh skew (seconds)</label>
                <input id="s-skew" type="number" min="0" value="${s.refreshSkewSeconds}" />
                <span class="help">Refresh a token this long before it expires.</span>
              </div>
              <div class="field">
                <label>Request timeout (ms)</label>
                <input id="s-timeout" type="number" min="1000" step="1000" value="${s.requestTimeoutMs}" />
              </div>
            </div>
            <div><button class="btn-primary" id="s-save">${icon("check", 16)} Save routing</button></div>
          </div>`)}

        ${card("Models", "bolt", `
          <div class="form">
            <div class="field">
              <label>Default model</label>
              <input id="s-default" value="${esc(s.defaultModel)}" list="s-model-list" />
              <datalist id="s-model-list"></datalist>
              <span class="help">Used in the snippets on Point Your Client. <code>auto</code> is a good default.</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="s-free" ${s.freeModelsOnly ? "checked" : ""} />
              <span class="switch-track"></span>
              <span>Free models only</span>
            </label>
            <span class="help">
              Hides anything that looks like a paid tier from <code>/v1/models</code> and from routing.
              Only OpenRouter marks this unambiguously (a <code>:free</code> suffix); everywhere else
              the key itself decides what it may spend, so nothing is filtered.
            </span>
            <div><button class="btn-primary" id="s-save-models">${icon("check", 16)} Save models</button></div>
          </div>

          <div class="mdl-head">
            <div>
              <div class="mdl-count" id="mdl-count">Loading…</div>
              <div class="help" id="mdl-sub"></div>
            </div>
            <input id="mdl-search" class="mdl-search" placeholder="Filter models…" />
          </div>
          <div class="mdl-chips" id="mdl-chips"></div>
          <div class="table-wrap" style="margin-top:10px;max-height:420px;overflow:auto"><table>
            <thead><tr><th>Model</th><th>Served by</th><th>Status</th></tr></thead>
            <tbody id="mdl-rows"><tr><td colspan="3"><div class="empty">Loading…</div></td></tr></tbody>
          </table></div>`)}

        ${card("Model capabilities", "hub", `
          <div class="note">${icon("warning", 16)}
            <span>The Codex backend publishes no capability manifest, so this is a
            <b>curated table, not detection</b>. Anything unverified defaults to off —
            a greyed-out icon that turns out to work is a smaller problem than a lit
            one that does not. Correct anything you find to be wrong; your edits
            override the built-in values.</span></div>
          <div class="table-wrap" style="margin-top:12px"><table>
            <thead><tr>
              <th>Model</th><th>Thinking</th><th>Vision</th><th>Tools</th>
              <th>Streaming</th><th>Internet</th><th>Context</th><th>Source</th><th></th>
            </tr></thead>
            <tbody id="cap-rows"><tr><td colspan="9"><div class="empty">Loading…</div></td></tr></tbody>
          </table></div>`)}

        ${card("Network", "settings", `
          <div class="form">
            <div class="grid-2">
              <div class="field">
                <label>Bind address</label>
                <input id="s-host" value="${esc(s.host)}" />
                <span class="help">127.0.0.1 keeps the gateway local. Read the exposure notes before changing.</span>
              </div>
              <div class="field">
                <label>Port</label>
                <input id="s-port" type="number" min="1" max="65535" value="${s.port}" />
              </div>
            </div>
            <div class="field">
              <label>Upstream Endpoint URL</label>
              <input id="s-upstream" value="${esc(s.upstreamBaseUrl || "https://api.openai.com/v1")}" placeholder="https://api.openai.com/v1" />
              <span class="help">
                Use <code>https://api.openai.com/v1</code> for OpenAI API Platform (Free tier & Paid Organization models: gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-4o), or <code>https://chatgpt.com/backend-api/codex</code> for Web ChatGPT Codex.
              </span>
            </div>
            <div class="field">
              <label>Log level</label>
              <select id="s-log">
                ${["debug", "info", "warn", "error"].map((l) => `<option ${s.logLevel === l ? "selected" : ""}>${l}</option>`).join("")}
              </select>
            </div>
            <div class="note warn">${icon("warning", 16)}
              <span>Changing the bind address or port needs a restart to take effect.
              Exposing this beyond loopback means the gateway key is the only thing
              between the internet and your accounts, over plain HTTP.</span></div>
            <div><button class="btn-primary" id="s-save-net">${icon("check", 16)} Save network & upstream</button></div>
          </div>`)}`;

      const helpFor = () => {
        const v = host.querySelector("#s-rotation").value;
        host.querySelector("#s-rot-help").textContent = strategies.find(([k]) => k === v)?.[1] ?? "";
      };
      host.querySelector("#s-rotation").addEventListener("change", helpFor);
      helpFor();

      const save = async (patch, label) => {
        try {
          const res = await post("/admin/settings", patch);
          toast(res.restartRequired ? `${label} saved — restart to apply` : `${label} saved`);
          await ctx.refresh();
          render();
        } catch (err) {
          toast(err.message, "bad");
        }
      };

      host.querySelector("#s-save").addEventListener("click", () =>
        save({
          rotation: host.querySelector("#s-rotation").value,
          maxAttempts: Number(host.querySelector("#s-attempts").value),
          defaultCooldownSeconds: Number(host.querySelector("#s-cooldown").value),
          refreshSkewSeconds: Number(host.querySelector("#s-skew").value),
          requestTimeoutMs: Number(host.querySelector("#s-timeout").value),
        }, "Routing"),
      );

      host.querySelector("#s-save-models").addEventListener("click", () =>
        save({
          defaultModel: host.querySelector("#s-default").value.trim(),
          freeModelsOnly: host.querySelector("#s-free").checked,
        }, "Models"),
      );

      host.querySelector("#s-save-net").addEventListener("click", () =>
        save({
          host: host.querySelector("#s-host").value.trim(),
          port: Number(host.querySelector("#s-port").value),
          logLevel: host.querySelector("#s-log").value,
          upstreamBaseUrl: host.querySelector("#s-upstream").value.trim(),
        }, "Network & Upstream"),
      );

      await renderCatalogue();
      await renderCapabilities();
    };

    /**
     * The live catalogue, straight from the connections.
     *
     * This card used to render a textarea of `cfg.models` labelled "these are
     * what /v1/models returns", which stopped being true once the catalogue
     * became derived — hence a pool of hundreds of models showing as a handful
     * of Gemini ids.
     */
    const renderCatalogue = async () => {
      const rows = host.querySelector("#mdl-rows");
      if (!rows) return;

      let data;
      try {
        data = await get("/admin/models/catalogue");
      } catch (err) {
        rows.innerHTML = emptyRow(3, err.message);
        return;
      }

      const list = host.querySelector("#s-model-list");
      if (list) list.innerHTML = data.models.map((m) => `<option value="${esc(m.id)}"></option>`).join("");

      const providers = Object.entries(data.byProvider).sort((a, b) => b[1] - a[1]);
      host.querySelector("#mdl-count").textContent =
        `${data.total} model${data.total === 1 ? "" : "s"} served, plus auto / fast / quality`;
      host.querySelector("#mdl-sub").textContent = data.hiddenPaid
        ? `${data.hiddenPaid} paid model${data.hiddenPaid === 1 ? "" : "s"} hidden by the free-only filter.`
        : "Nothing is being hidden.";
      host.querySelector("#mdl-chips").innerHTML = providers
        .map(([p, n]) => `<span class="tag">${esc(p)} <b>${n}</b></span>`)
        .join("");

      const draw = (needle) => {
        const q = needle.trim().toLowerCase();
        const shown = q ? data.models.filter((m) => m.id.toLowerCase().includes(q)) : data.models;
        rows.innerHTML = shown.length
          ? shown.map((m) => `<tr>
              <td class="mono">${esc(m.id)}${m.virtual ? ` <span class="tag ok">policy</span>` : ""}
                ${m.description ? `<div class="help">${esc(m.description)}</div>` : ""}</td>
              <td>${m.providers.map((p) => `<span class="tag">${esc(p)}</span>`).join(" ")}</td>
              <td><span class="tag ${m.available ? "active" : "cooling"}">${m.available ? "ready" : "cooling"}</span></td>
            </tr>`).join("")
          : emptyRow(3, `Nothing matches "${esc(needle)}".`);
      };

      draw("");
      const search = host.querySelector("#mdl-search");
      if (search) search.addEventListener("input", () => draw(search.value));
    };

    const FLAGS = ["reasoning", "vision", "tools", "streaming", "webSearch"];

    const renderCapabilities = async () => {
      let data;
      try {
        data = await get("/admin/chat/capabilities");
      } catch (err) {
        return toast(err.message, "bad");
      }

      const body = host.querySelector("#cap-rows");
      if (!body) return;
      const models = Object.keys(data.resolved);

      body.innerHTML = models.length
        ? models.map((m) => {
            const c = data.resolved[m];
            return `<tr data-capmodel="${esc(m)}">
              <td class="mono">${esc(m)}</td>
              ${FLAGS.map((f) => `<td><label class="switch">
                  <input type="checkbox" data-flag="${f}" ${c[f] ? "checked" : ""} />
                  <span class="switch-track"></span></label></td>`).join("")}
              <td><input data-ctx type="number" min="0" value="${c.contextWindow ?? ""}"
                         placeholder="unknown" style="width:100px;padding:4px 7px;font-size:11.5px" /></td>
              <td><span class="tag">${esc(c.source)}</span></td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn-sm" data-capsave="${esc(m)}">${icon("check", 13)}</button>
                ${c.source === "override"
                  ? `<button class="btn-sm btn-danger" data-capreset="${esc(m)}" title="Revert to built-in">${icon("refresh", 13)}</button>`
                  : ""}
              </td>
            </tr>`;
          }).join("")
        : emptyRow(9, "No models configured.");

      body.querySelectorAll("[data-capsave]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const model = btn.dataset.capsave;
          const row = body.querySelector(`[data-capmodel="${CSS.escape(model)}"]`);
          const patch = {};
          for (const f of FLAGS) {
            patch[f] = row.querySelector(`[data-flag="${f}"]`).checked;
          }
          const ctxValue = row.querySelector("[data-ctx]").value.trim();
          patch.contextWindow = ctxValue === "" ? null : Number(ctxValue);

          try {
            await post(`/admin/settings/capabilities/${encodeURIComponent(model)}`, patch);
            toast(`${model} capabilities saved`);
            await renderCapabilities();
          } catch (err) {
            toast(err.message, "bad");
          }
        }),
      );

      body.querySelectorAll("[data-capreset]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          try {
            // An empty patch clears the override and falls back to built-ins.
            await post(`/admin/settings/capabilities/${encodeURIComponent(btn.dataset.capreset)}`, {});
            toast("Reverted to built-in values");
            await renderCapabilities();
          } catch (err) {
            toast(err.message, "bad");
          }
        }),
      );
    };

    render();
    return {};
  },
};

/* --------------------------------------------------------------- about */

export const about = {
  title: "About",
  subtitle: "Open-Auther release information and update status",

  mount(host, ctx) {
    let update = null;

    const render = async () => {
      host.innerHTML = `<div class="page"><div class="empty">Checking for updates…</div></div>`;
      try {
        update = await get("/admin/update");
      } catch (err) {
        host.innerHTML = `<div class="page"><div class="note bad">${icon("error", 16)}<span>${esc(err.message)}</span></div></div>`;
        return;
      }

      const tone = update.state === "update_available" ? "warn" : update.state === "error" ? "bad" : "ok";
      const symbol = tone === "ok" ? "check" : tone === "warn" ? "warning" : "error";
      const current = ctx.status?.gateway?.version ?? update.currentVersion;
      const latest = update.latestVersion ?? "Unavailable";

      host.innerHTML = `<div class="page">
        <div class="grid-2">
          ${card("Open-Auther", "spark", `
            <div class="about-brand">
              <div class="about-mark">${icon("spark", 28)}</div>
              <div>
                <div class="about-name">Open-Auther</div>
                <div class="help">OpenAI-compatible authentication gateway and model router.</div>
              </div>
            </div>
            <div class="table-wrap" style="margin-top:16px"><table><tbody>
              <tr><td style="color:var(--text-dim);width:42%">Installed version</td><td class="mono">v${esc(current)}</td></tr>
              <tr><td style="color:var(--text-dim)">Latest npm version</td><td class="mono">${esc(latest)}</td></tr>
              <tr><td style="color:var(--text-dim)">Package</td><td><a href="${esc(update.packageUrl)}" target="_blank" rel="noreferrer">open-auther ${icon("external", 13)}</a></td></tr>
            </tbody></table></div>`)}

          ${card("Update status", "refresh", `
            <div class="note ${tone}">${icon(symbol, 16)}<span><b>${esc(update.message)}</b></span></div>
            ${update.state === "update_available"
              ? `<div class="field" style="margin-top:14px"><label>Update command</label><code class="about-command">${esc(update.installCommand)}</code>
                   <span class="help">Run this in a terminal, then restart the gateway.</span></div>`
              : ""}
            ${update.state === "error"
              ? `<div class="help" style="margin-top:14px">The registry could not be reached. The installed gateway continues to work normally.</div>`
              : ""}
            <div style="margin-top:16px"><button class="btn-primary" id="about-check">${icon("refresh", 15)} Check again</button></div>`)}
        </div>

        ${card("Release information", "logs", `
          <div class="note">${icon("shield", 16)}
            <span>Updates are checked against the public npm registry. No gateway keys,
            OAuth tokens, or local configuration are sent.</span></div>
          <div class="help" style="margin-top:12px">Last checked: ${esc(new Date(update.checkedAt).toLocaleString())}</div>`)}
      </div>`;

      host.querySelector("#about-check")?.addEventListener("click", render);
    };

    render();
    return {};
  },
};