/* Pages: Home, Auths, Add Auth, API Keys, Point Your Client. */

import {
  card, compact, confirmDialog, copy, del, emptyRow, esc, get, modal, num, post,
  relative, state, stateTag, toast,
} from "./core.js";
import { GalaxyGraph } from "./graph.js";
import { icon } from "./icons.js";

const EVENT_TONE = {
  request_ok: "ok", credential_added: "ok", credential_woke: "ok", credential_revived: "ok",
  token_refreshed: "info", plan_changed: "info", credential_renamed: "info",
  credential_cooling: "warn", credential_dead: "bad", credential_removed: "bad",
};

const EVENT_TEXT = {
  request_ok: "served a request", credential_added: "joined the pool",
  credential_woke: "back in rotation", credential_revived: "revived",
  token_refreshed: "token refreshed", plan_changed: "plan changed",
  credential_renamed: "renamed", credential_cooling: "cooling down",
  credential_dead: "dropped from rotation", credential_removed: "removed",
};

/* ------------------------------------------------------------------ home */

export const home = {
  title: "Home",
  subtitle: "Pool topology and live activity",

  mount(host, ctx) {
    const s = ctx.status;
    const base = s?.gateway.baseUrl ?? "http://127.0.0.1:8787/v1";
    const hasAuths = (s?.summary.total ?? 0) > 0;

    host.innerHTML = `
      <div class="page">
        ${card("Get connected", "bolt", `
          <div class="steps">
            <div class="step ${state.key ? "done" : ""}">
              <div class="step-n">1</div>
              <div class="step-body">
                <h4>API key</h4>
                <p>You are already using one. Manage or add more under <a href="#/keys">API Keys</a>.</p>
              </div>
            </div>
            <div class="step ${hasAuths ? "done" : ""}">
              <div class="step-n">2</div>
              <div class="step-body">
                <h4>Connect an Auth</h4>
                <p>${hasAuths
                  ? `${s.summary.total} connected. Add more in <a href="#/add">Add Auth</a>.`
                  : `Run the Codex OAuth flow in <a href="#/add">Add Auth</a>, or import existing credentials.`}</p>
              </div>
            </div>
            <div class="step ${hasAuths ? "done" : ""}">
              <div class="step-n">3</div>
              <div class="step-body">
                <h4>Point your client</h4>
                <p>Set <code>base_url</code> to <code>${esc(base)}</code>. Snippets in <a href="#/client">Point Your Client</a>.</p>
              </div>
            </div>
            <div class="step">
              <div class="step-n">4</div>
              <div class="step-body">
                <h4>Watch it route</h4>
                <p>Rotation is always on. When an Auth hits its limit the next one takes over automatically — see <a href="#/logs">Logs</a> and <a href="#/health">Health</a>.</p>
              </div>
            </div>
          </div>`)}

        <div class="grid-4" id="home-stats"></div>

        ${card("Pool topology", "hub", `
          <div class="stage">
            <canvas id="graph"></canvas>
            <div class="stage-legend">
              <span><i class="dot core"></i>gateway</span>
              <span><i class="dot active"></i>active</span>
              <span><i class="dot cooling"></i>cooling</span>
              <span><i class="dot dead"></i>dead</span>
            </div>
            <div class="stage-empty" id="stage-empty" hidden>
              <h3>No Auths connected</h3>
              <p>Connect a ChatGPT account and it appears here as an orbiting node.</p>
              <a class="btn btn-primary" href="#/add">${icon("personAdd", 16)} Add an Auth</a>
            </div>
            <div class="tooltip" id="tooltip" hidden></div>
          </div>`,
          `<span class="pill">rotation <b>${esc(s?.gateway.rotation ?? "fill_first")}</b></span>`,
          "Orbit distance shows state. Inner orbits are healthy.")}

        ${card("Live activity", "logs", `<ul class="list" id="feed"></ul>`)}
      </div>`;

    const graph = new GalaxyGraph(host.querySelector("#graph"), host.querySelector("#tooltip"));
    graph.onSelect = (cred) => {
      location.hash = `#/auths?focus=${cred.id}`;
    };
    ctx.setGraph(graph);

    const feed = host.querySelector("#feed");
    const renderFeed = () => {
      const items = ctx.events.slice(0, 40);
      feed.innerHTML = items.length
        ? items.map((ev) => {
            const tone = EVENT_TONE[ev.kind] ?? "";
            const who = ev.credentialId
              ? esc(ctx.nameFor(ev.credentialId))
              : "gateway";
            const extra = ev.detail?.reason ? ` · ${esc(String(ev.detail.reason))}` : "";
            return `<li class="feed-item">
              <span class="feed-dot ${tone}"></span>
              <span class="feed-text"><b>${who}</b> ${esc(EVENT_TEXT[ev.kind] ?? ev.kind.replace(/_/g, " "))}${extra}</span>
              <span class="feed-time">${new Date(ev.ts * 1000).toLocaleTimeString()}</span>
            </li>`;
          }).join("")
        : `<li class="empty">Waiting for activity…</li>`;
    };

    const renderStats = () => {
      const st = ctx.status;
      if (!st) return;
      host.querySelector("#home-stats").innerHTML = `
        <div class="stat ok"><div class="stat-value">${st.summary.active}</div><div class="stat-label">Active</div></div>
        <div class="stat"><div class="stat-value" style="color:var(--warn)">${st.summary.cooling}</div><div class="stat-label">Cooling</div>
          ${st.summary.nextRecoveryAt && st.summary.active === 0
            ? `<div class="stat-note">first reset ${esc(relative(st.summary.nextRecoveryAt, st.now))}</div>` : ""}</div>
        <div class="stat"><div class="stat-value">${compact(st.summary.requestsServed)}</div><div class="stat-label">Requests</div></div>
        <div class="stat accent"><div class="stat-value">${compact(st.summary.tokensServed)}</div><div class="stat-label">Tokens</div></div>`;
    };

    const onStatus = () => {
      const st = ctx.status;
      graph.sync(st?.credentials ?? []);
      host.querySelector("#stage-empty").hidden = (st?.summary.total ?? 0) > 0;
      renderStats();
    };

    const onEvent = (ev) => {
      renderFeed();
      if (ev.credentialId) {
        const tone = EVENT_TONE[ev.kind];
        graph.pulse(ev.credentialId, tone === "bad" ? "bad" : tone === "warn" ? "warn" : "ok");
      }
    };

    onStatus();
    renderFeed();

    return { onStatus, onEvent, destroy: () => graph.stop() };
  },
};

/* ----------------------------------------------------------------- auths */

export const auths = {
  title: "Connections",
  subtitle: "Connected Provider accounts and API key pools in rotation",

  mount(host, ctx) {
    host.innerHTML = `<div class="page">
      ${card("Rotation", "refresh", `
        <div class="note">
          ${icon("shield", 16)}
          <span>Rotation is always active across all active Providers & API Keys. When a provider returns rate limits (429), ai-auther cools it until reset and moves to the next key mid-request.</span>
        </div>`,
        `<span class="pill">strategy <b id="rot-strategy">—</b></span>`)}
      ${card("Connections", "hub",
        `<div class="table-wrap"><table>
          <thead><tr>
            <th>Name</th><th>Provider</th><th>State</th>
            <th style="text-align:right">Requests</th>
            <th style="text-align:right">Tokens</th>
            <th>Resets</th><th>Last error</th><th>Test</th><th></th>
          </tr></thead>
          <tbody id="auth-rows"></tbody>
        </table></div>`,
        `<button class="btn-sm" id="test-all">${icon("play", 15)} Test all</button>
         <a class="btn btn-sm btn-primary" href="#/add">${icon("add", 15)} Add Provider</a>`)}
    </div>`;

    const focusId = Number(new URLSearchParams(location.hash.split("?")[1] ?? "").get("focus"));

    const results = new Map();

    const render = () => {
      const st = ctx.status;
      host.querySelector("#rot-strategy").textContent = st?.gateway.rotation ?? "—";
      const rows = st?.credentials ?? [];
      const body = host.querySelector("#auth-rows");

      body.innerHTML = rows.length
        ? rows.map((c) => `
          <tr ${c.id === focusId ? 'style="background:var(--surface-2)"' : ""}>
            <td>
              <div style="font-weight:500">${esc(c.name)}</div>
              <div style="font-size:11px;color:var(--text-faint)">#${c.id} · ${esc(c.emailMasked)}</div>
            </td>
            <td><span class="pill">${esc(c.providerType || (c.accountId.startsWith("gemini_") ? "gemini" : "codex"))}</span></td>
            <td>${stateTag(c.effectiveState)}</td>
            <td class="num">${num(c.requestCount)}</td>
            <td class="num">${compact(c.tokenCount)}</td>
            <td class="mono" id="quota-${c.id}">${quotaCell(c, st.now)}</td>
            <td class="mono" style="color:var(--bad)">${esc(c.lastError ?? "—")}</td>
            <td id="test-${c.id}" class="mono" style="white-space:nowrap">${resultCell(c.id)}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn-sm" data-test="${c.id}" title="Send a real 'hi' through this Auth">${icon("play", 14)}</button>
              <button class="btn-sm" data-quota="${c.id}" title="Re-check quota: what has refilled, and when the rest does">${icon("refresh", 14)}</button>
              <button class="btn-sm" data-rename="${c.id}" title="Rename">${icon("edit", 14)}</button>
              ${c.effectiveState === "dead"
                ? `<button class="btn-sm" data-revive="${c.id}" title="Return to rotation">${icon("refresh", 14)}</button>`
                : `<button class="btn-sm" data-cool="${c.id}" title="Cool down for an hour">${icon("pause", 14)}</button>`}
              <button class="btn-sm btn-danger" data-remove="${c.id}" title="Remove">${icon("trash", 14)}</button>
            </td>
          </tr>`).join("")
        : emptyRow(9, "No Auths yet. Add one to start routing.");
    };

    /** Live quota readings, keyed by credential id. Filled by the refresh button. */
    const quotas = new Map();

    /**
     * The Resets column.
     *
     * No provider here publishes a "requests remaining" figure — the only
     * quota signal any of them gives is a 429 carrying a reset time. So this
     * shows what is real: how many of the Auth's models can serve right now,
     * and when the next cooling one comes back. A refill percentage would look
     * better and mean nothing.
     */
    function quotaCell(c, nowTs) {
      const q = quotas.get(c.id);
      if (!q) return esc(relative(c.resetsAt ?? c.cooldownUntil, nowTs));
      if (q.pending) return `<span style="color:var(--text-faint)">checking…</span>`;

      const when = q.nextRecoveryAt
        ? `<div style="font-size:11px;color:var(--warn)">refills ${esc(relative(q.nextRecoveryAt, q.now))}</div>`
        : `<div style="font-size:11px;color:var(--text-faint)">nothing cooling</div>`;

      const colour = q.models.ready ? "var(--ok)" : "var(--bad)";
      return `<span style="color:${colour}">${q.models.ready}/${q.models.total} ready</span>${when}`;
    }

    const refreshQuota = async (id) => {
      quotas.set(id, { pending: true });
      const paint = () => {
        const cell = host.querySelector(`#quota-${id}`);
        const c = (ctx.status?.credentials ?? []).find((x) => x.id === id);
        if (cell && c) cell.innerHTML = quotaCell(c, ctx.status.now);
      };
      paint();

      try {
        const q = await post(`/admin/providers/credentials/${id}/refresh`, {});
        quotas.set(id, q);
        await ctx.refresh();
        paint();
        toast(
          q.nextRecoveryAt
            ? `${q.credential.name}: ${q.models.ready}/${q.models.total} ready, next refill ${relative(q.nextRecoveryAt, q.now)}`
            : `${q.credential.name}: ${q.models.ready}/${q.models.total} models ready, nothing cooling`,
          q.models.ready ? "ok" : "bad",
        );
      } catch (err) {
        quotas.delete(id);
        paint();
        toast(err.message, "bad");
      }
    };

    /** Cell markup for whatever the last test said about this Auth. */
    function resultCell(id) {
      const r = results.get(id);
      if (!r) return "";
      if (r.pending) return `<span style="color:var(--text-faint)">${esc(r.pending)}</span>`;
      return r.ok
        ? `<span style="color:var(--ok)" title="${esc(r.reply ?? "")}">ok · ${r.latencyMs}ms</span>`
        : `<span style="color:var(--bad)" title="${esc(r.message ?? "")}">${esc(r.code ?? "failed")}</span>`;
    }

    const setResult = (id, r) => {
      results.set(id, r);
      const cell = host.querySelector(`#test-${id}`);
      if (cell) cell.innerHTML = resultCell(id);
    };

    const runTest = async (id) => {
      setResult(id, { pending: "testing…" });
      try {
        const r = await post(`/admin/credentials/${id}/test`, {});
        setResult(id, r);
        toast(
          r.ok ? `${r.name} replied in ${r.latencyMs}ms` : `${r.name}: ${r.message ?? r.code}`,
          r.ok ? "ok" : "bad",
        );
        await ctx.refresh();
      } catch (err) {
        setResult(id, { ok: false, code: "error", message: err.message });
        toast(err.message, "bad");
      }
    };

    host.querySelector("#test-all").addEventListener("click", async (e) => {
      const count = ctx.status?.credentials.length ?? 0;
      if (count === 0) return toast("No Auths to test.", "bad");

      const ok = await confirmDialog(
        "Test every Auth",
        `This sends a real message through each of the ${count} Auths, one at a time. ` +
          `Each test spends a request from that account's quota.`,
        `Test ${count}`,
      );
      if (!ok) return;

      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = `${icon("refresh", 15, "spin")} Testing…`;
      for (const c of ctx.status.credentials) setResult(c.id, { pending: "queued" });
      try {
        // Sequential server-side: firing them in parallel from one IP is the
        // pattern that gets a cluster of accounts flagged.
        const res = await post("/admin/credentials/test-all", {});
        for (const r of res.results) setResult(r.credentialId, r);
        const passed = res.results.filter((r) => r.ok).length;
        toast(`${passed} of ${res.results.length} Auths replied`, passed === res.results.length ? "ok" : "bad");
        await ctx.refresh();
      } catch (err) {
        toast(err.message, "bad");
      } finally {
        btn.disabled = false;
        btn.innerHTML = `${icon("play", 15)} Test all`;
      }
    });

    host.addEventListener("click", async (e) => {
      const btn = e.target.closest(
        "button[data-rename],button[data-revive],button[data-cool],button[data-remove],button[data-test],button[data-quota]",
      );
      if (!btn) return;
      const id = Number(
        btn.dataset.rename ?? btn.dataset.revive ?? btn.dataset.cool ?? btn.dataset.remove ??
          btn.dataset.test ?? btn.dataset.quota,
      );
      const cred = ctx.status?.credentials.find((c) => c.id === id);

      try {
        if (btn.dataset.test) {
          await runTest(id);
          return;
        }
        if (btn.dataset.quota) {
          await refreshQuota(id);
          return;
        }
        if (btn.dataset.rename) {
          const name = await modal({
            title: "Rename Auth",
            body: `<div class="field">
                     <label>Display name</label>
                     <input id="rn" value="${esc(cred?.name ?? "")}" maxlength="60" placeholder="e.g. work-account" />
                     <span class="help">Shown in the graph, logs and lists. Emails are never displayed.</span>
                   </div>`,
            footer: `<button data-close>Cancel</button><button class="btn-primary" data-save>Save</button>`,
            onMount: (root, close) => {
              const save = () => close(root.querySelector("#rn").value);
              root.querySelector("[data-save]").addEventListener("click", save);
              root.querySelector("#rn").addEventListener("keydown", (ev) => ev.key === "Enter" && save());
            },
          });
          if (name === null) return;
          await post(`/admin/credentials/${id}/rename`, { name });
          toast("Renamed");
        } else if (btn.dataset.revive) {
          await post(`/admin/credentials/${id}/revive`);
          toast("Returned to rotation");
        } else if (btn.dataset.cool) {
          await post(`/admin/credentials/${id}/cool`, { seconds: 3600 });
          toast("Cooling for one hour");
        } else if (btn.dataset.remove) {
          const ok = await confirmDialog(
            "Remove Auth",
            `Remove "${cred?.name ?? id}" from the pool? The stored tokens are deleted. ` +
              `This does not sign the account out at OpenAI.`,
            "Remove",
          );
          if (!ok) return;
          await del(`/admin/credentials/${id}`);
          toast("Removed");
        }
        await ctx.refresh();
      } catch (err) {
        toast(err.message, "bad");
      }
    });

    render();
    return { onStatus: render };
  },
};

/* -------------------------------------------------------------- add auth */

export const addAuth = {
  title: "Add Provider",
  subtitle: "Add Gemini API Keys, Custom OpenAI Providers, or ChatGPT accounts to the pool",

  mount(host, ctx) {
    host.innerHTML = `<div class="page">
      ${card("1. Add Gemini API Keys (100% Free - Recommended)", "bolt", `
        <div class="form">
          <div class="note ok">
            ${icon("check", 16)}
            <span>Add 1 to 10+ Gemini API keys from Google AI Studio. <code>ai-auther</code> load balances across all keys with automatic 429 quota rotation for unstoppable performance!</span>
          </div>
          <div class="field">
            <label>Gemini API Keys</label>
            <textarea id="gemini-keys" style="min-height:100px" placeholder="Paste your Gemini API key(s) here (one per line):&#10;AIzaSyA...&#10;AIzaSyB..."></textarea>
            <span class="help">Get free Gemini API keys at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com</a>.</span>
          </div>
          <div class="field">
            <label>Name / Label (Optional)</label>
            <input id="gemini-label" placeholder="e.g. Free Gemini Pool" maxlength="60" />
          </div>
          <div>
            <button class="btn-primary" id="gemini-add">${icon("add", 16)} Add Gemini Key(s) to Rotation</button>
          </div>
          <div id="gemini-status"></div>
        </div>`)}

      ${card("2. Add Custom Provider (OpenAI-compatible Endpoint)", "link", `
        <div class="form">
          <div class="field">
            <label>Provider Name</label>
            <input id="custom-name" placeholder="e.g. Groq / Together / DeepSeek" maxlength="60" />
          </div>
          <div class="field">
            <label>Base Endpoint URL</label>
            <input id="custom-url" placeholder="https://api.groq.com/openai/v1" />
            <span class="help">Any OpenAI-compatible API base URL ending in /v1 or containing /chat/completions.</span>
          </div>
          <div class="field">
            <label>API Key</label>
            <input id="custom-key" type="password" placeholder="gsk_... or sk-..." />
          </div>
          <div class="field">
            <label>Supported Models (Comma-separated, Optional)</label>
            <input id="custom-models" placeholder="llama-3.3-70b, deepseek-r1" />
          </div>
          <div>
            <button class="btn-primary" id="custom-add">${icon("add", 16)} Add Custom Provider</button>
          </div>
          <div id="custom-status"></div>
        </div>`)}

      ${card("3. Connect ChatGPT OAuth (Codex)", "personAdd", `
        <div class="form">
          <div class="field">
            <label>Name for this Auth</label>
            <input id="oauth-name" placeholder="e.g. account-2" maxlength="60" />
          </div>
          <div>
            <button class="btn-primary" id="oauth-start">${icon("link", 16)} Start OAuth login</button>
          </div>
          <div id="oauth-status"></div>
        </div>`)}

      ${card("4. Import Credential JSON", "cloud", `
        <div class="form">
          <div class="field">
            <label>Credential JSON</label>
            <textarea id="import-json" placeholder='Paste a Codex auth.json, a flat {"access_token": …} object, or an array of either.'></textarea>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Name</label>
              <input id="import-name" placeholder="Optional" maxlength="60" />
            </div>
            <button class="btn-primary" id="import-go">${icon("add", 16)} Import</button>
          </div>
          <div id="import-status"></div>
        </div>`)}
    </div>`;

    // Gemini add listener
    host.querySelector("#gemini-add").addEventListener("click", async () => {
      const text = host.querySelector("#gemini-keys").value;
      const label = host.querySelector("#gemini-label").value;
      const keys = text.split("\n").map((k) => k.trim()).filter(Boolean);
      const status = host.querySelector("#gemini-status");
      if (keys.length === 0) {
        toast("Please enter at least one Gemini API key", "bad");
        return;
      }
      try {
        const res = await post("/admin/auth/gemini", { keys, label });
        toast(`Added ${res.count} Gemini key(s) to rotation!`);
        host.querySelector("#gemini-keys").value = "";
        status.innerHTML = `<div class="note ok">${icon("check", 16)} Added ${res.count} Gemini API key(s) successfully!</div>`;
        await ctx.refresh();
      } catch (err) {
        toast(err.message, "bad");
      }
    });

    // Custom provider add listener
    host.querySelector("#custom-add").addEventListener("click", async () => {
      const name = host.querySelector("#custom-name").value;
      const baseUrl = host.querySelector("#custom-url").value;
      const apiKey = host.querySelector("#custom-key").value;
      const rawModels = host.querySelector("#custom-models").value;
      const models = rawModels.split(",").map((m) => m.trim()).filter(Boolean);
      const status = host.querySelector("#custom-status");

      if (!baseUrl || !apiKey) {
        toast("Base URL and API Key are required", "bad");
        return;
      }
      try {
        await post("/admin/auth/custom", { name, baseUrl, apiKey, models });
        toast(`Custom Provider "${name || "Custom"}" added to rotation!`);
        host.querySelector("#custom-url").value = "";
        host.querySelector("#custom-key").value = "";
        status.innerHTML = `<div class="note ok">${icon("check", 16)} Custom provider added successfully!</div>`;
        await ctx.refresh();
      } catch (err) {
        toast(err.message, "bad");
      }
    });

    let polling = null;
    const statusEl = host.querySelector("#oauth-status");

    const stopPolling = () => {
      if (polling) clearInterval(polling);
      polling = null;
    };

    host.querySelector("#oauth-start").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      stopPolling();

      try {
        const name = host.querySelector("#oauth-name").value.trim();
        const session = await post("/admin/auth/login", { name });

        statusEl.innerHTML = `
          <div class="note">
            ${icon("clock", 16)}
            <div style="min-width:0">
              <div>Waiting for you to finish signing in…</div>
              <div class="copyrow" style="margin-top:8px">
                <div class="code">${esc(session.authorizeUrl)}</div>
                <button class="btn-sm" id="oauth-copy">${icon("copy", 14)}</button>
              </div>
              <div style="margin-top:8px;display:flex;gap:8px">
                <a class="btn btn-sm btn-primary" href="${esc(session.authorizeUrl)}" target="_blank" rel="noopener">
                  ${icon("external", 14)} Open sign-in
                </a>
                <button class="btn-sm" id="oauth-cancel">Cancel</button>
              </div>
            </div>
          </div>`;

        statusEl.querySelector("#oauth-copy").addEventListener("click", () => copy(session.authorizeUrl, "Link copied"));
        statusEl.querySelector("#oauth-cancel").addEventListener("click", async () => {
          stopPolling();
          await post(`/admin/auth/login/${session.id}/cancel`).catch(() => {});
          statusEl.innerHTML = "";
          btn.disabled = false;
        });

        polling = setInterval(async () => {
          try {
            const s = await get(`/admin/auth/login/${session.id}`);
            if (s.state === "pending") return;
            stopPolling();
            btn.disabled = false;

            if (s.state === "complete") {
              statusEl.innerHTML = `<div class="note ok">${icon("check", 16)}
                <div style="min-width:0">
                  <div>Auth connected and added to the rotation.</div>
                  <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
                    <button class="btn-sm btn-primary" data-testnew="${s.credentialId}">
                      ${icon("play", 14)} Test connection
                    </button>
                    <a class="btn btn-sm" href="#/auths">View Auths</a>
                  </div>
                  <div id="oauth-test-out"></div>
                </div></div>`;
              host.querySelector("#oauth-name").value = "";
              toast("Auth connected");
              await ctx.refresh();
            } else if (s.state === "error") {
              statusEl.innerHTML = `<div class="note ${s.duplicate ? "warn" : "bad"}">
                ${icon(s.duplicate ? "warning" : "error", 16)}<span>${esc(s.error ?? "Login failed.")}</span></div>`;
            }
          } catch {
            stopPolling();
            btn.disabled = false;
          }
        }, 1500);
      } catch (err) {
        btn.disabled = false;
        statusEl.innerHTML = `<div class="note bad">${icon("error", 16)}<span>${esc(err.message)}</span></div>`;
      }
    });

    /**
     * Verify a specific Auth by sending a real message through it. Shared by
     * the OAuth and import flows so a newly added account can be checked
     * without leaving the page.
     */
    const testAndReport = async (id, outEl, btn) => {
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `${icon("refresh", 14, "spin")} Testing…`;
      outEl.innerHTML = "";

      try {
        const r = await post(`/admin/credentials/${id}/test`, {});
        outEl.innerHTML = `
          <div class="test-result ${r.ok ? "ok" : "bad"}">
            <div class="test-row">${icon(r.ok ? "check" : "error", 15)}
              <span>${r.ok
                ? `<b>${esc(r.name)}</b> replied in ${r.latencyMs}ms — the connection is healthy.`
                : `<b>${esc(r.name)}</b> failed: ${esc(r.message ?? r.code ?? "unknown error")}`}</span>
            </div>
            ${r.reply ? `<div class="test-reply">${esc(r.reply)}</div>` : ""}
            ${r.terminal ? `<div style="margin-top:6px;color:var(--bad)">This Auth has been dropped from rotation.</div>` : ""}
          </div>`;
        await ctx.refresh();
      } catch (err) {
        outEl.innerHTML = `<div class="test-result bad"><div class="test-row">
          ${icon("error", 15)}<span>${esc(err.message)}</span></div></div>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    };

    host.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-testnew]");
      if (!btn) return;
      const out = btn.closest("div").parentElement.querySelector("#oauth-test-out, #import-test-out");
      if (out) testAndReport(Number(btn.dataset.testnew), out, btn);
    });

    host.querySelector("#import-go").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const out = host.querySelector("#import-status");
      const raw = host.querySelector("#import-json").value.trim();
      if (!raw) return toast("Paste some credential JSON first.", "bad");

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        out.innerHTML = `<div class="note bad">${icon("error", 16)}<span>That is not valid JSON.</span></div>`;
        return;
      }

      btn.disabled = true;
      try {
        const name = host.querySelector("#import-name").value.trim();
        const result = await post("/admin/auth/import", { payload, name: name || null });
        const added = result.added ?? [];
        const skipped = result.skipped ?? [];
        out.innerHTML = `<div class="note ${added.length ? "ok" : "warn"}">
          ${icon(added.length ? "check" : "warning", 16)}
          <div style="min-width:0">
            <div>${added.length} added, ${skipped.length} skipped.</div>
            ${added.map((a) => `<div style="font-size:11.5px;color:var(--text-faint)">+ ${esc(a.name)} (${esc(a.email)})</div>`).join("")}
            ${skipped.map((s) => `<div style="font-size:11.5px;color:var(--text-faint)">− ${esc(s.detail)}</div>`).join("")}
            ${added.length
              ? `<div style="margin-top:8px"><button class="btn-sm btn-primary" data-testnew="${added[0].id}">
                   ${icon("play", 14)} Test ${esc(added[0].name)}
                 </button></div>
                 <div id="import-test-out"></div>`
              : ""}
          </div></div>`;
        if (added.length) {
          host.querySelector("#import-json").value = "";
          await ctx.refresh();
        }
      } catch (err) {
        out.innerHTML = `<div class="note bad">${icon("error", 16)}<span>${esc(err.message)}</span></div>`;
      } finally {
        btn.disabled = false;
      }
    });

    return { destroy: stopPolling };
  },
};

/* ------------------------------------------------------------------ keys */

export const keys = {
  title: "API Keys",
  subtitle: "Keys your clients use to reach this gateway",

  mount(host, ctx) {
    host.innerHTML = `<div class="page">
      ${card("Gateway keys", "key",
        `<div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Key</th><th></th></tr></thead>
          <tbody id="key-rows"></tbody>
        </table></div>
        <div class="note" style="margin-top:12px">${icon("shield", 16)}
          <span>Give each client its own key so one can be revoked without breaking the others.
          Logs record the key <b>name</b>, never the key.</span></div>`,
        `<button class="btn-sm btn-primary" id="key-new">${icon("add", 15)} Generate key</button>`)}
    </div>`;

    const revealed = new Set();

    const render = async () => {
      const { keys: list } = await get("/admin/keys");
      host.querySelector("#key-rows").innerHTML = list.length
        ? list.map((k) => {
            const shown = revealed.has(k.name);
            return `<tr>
              <td style="font-weight:500">${esc(k.name)}</td>
              <td class="secret">${shown ? esc(k.key) : "•".repeat(28)}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn-sm" data-reveal="${esc(k.name)}">${icon(shown ? "eyeOff" : "eye", 14)}</button>
                <button class="btn-sm" data-copy="${esc(k.name)}">${icon("copy", 14)}</button>
                <button class="btn-sm btn-danger" data-del="${esc(k.name)}">${icon("trash", 14)}</button>
              </td>
            </tr>`;
          }).join("")
        : emptyRow(3, "No keys configured.");

      host.querySelectorAll("[data-reveal]").forEach((b) =>
        b.addEventListener("click", () => {
          const n = b.dataset.reveal;
          revealed.has(n) ? revealed.delete(n) : revealed.add(n);
          render();
        }),
      );
      host.querySelectorAll("[data-copy]").forEach((b) =>
        b.addEventListener("click", () => {
          copy(list.find((k) => k.name === b.dataset.copy).key, "Key copied");
        }),
      );
      host.querySelectorAll("[data-del]").forEach((b) =>
        b.addEventListener("click", async () => {
          const ok = await confirmDialog(
            "Revoke key",
            `Revoke "${b.dataset.del}"? Any client using it stops working immediately.`,
            "Revoke",
          );
          if (!ok) return;
          try {
            await del(`/admin/keys/${encodeURIComponent(b.dataset.del)}`);
            toast("Key revoked");
            render();
          } catch (err) {
            toast(err.message, "bad");
          }
        }),
      );
    };

    host.querySelector("#key-new").addEventListener("click", async () => {
      const name = await modal({
        title: "Generate gateway key",
        body: `<div class="field">
                 <label>Name</label>
                 <input id="kn" placeholder="e.g. cursor" maxlength="40" />
                 <span class="help">A label for the client that will use it.</span>
               </div>`,
        footer: `<button data-close>Cancel</button><button class="btn-primary" data-save>Generate</button>`,
        onMount: (root, close) => {
          const save = () => close(root.querySelector("#kn").value);
          root.querySelector("[data-save]").addEventListener("click", save);
          root.querySelector("#kn").addEventListener("keydown", (e) => e.key === "Enter" && save());
        },
      });
      if (name === null) return;
      try {
        const res = await post("/admin/keys", { name });
        revealed.add(res.key.name);
        toast("Key generated");
        render();
        ctx.refresh();
      } catch (err) {
        toast(err.message, "bad");
      }
    });

    render();
    return {};
  },
};

/* ---------------------------------------------------------------- client */

export const client = {
  title: "Point Your Client",
  subtitle: "Everything an OpenAI-compatible client needs",

  mount(host, ctx) {
    const s = ctx.status;
    const base = s?.gateway.baseUrl ?? `${location.origin}/v1`;
    const key = state.key ?? "YOUR_KEY";
    const model = s?.gateway.defaultModel ?? "gpt-4o";

    const block = (id, text) => `
      <div class="copyrow">
        <div class="code" id="${id}">${esc(text)}</div>
        <button class="btn-sm" data-copytext="${id}">${icon("copy", 14)}</button>
      </div>`;

    host.innerHTML = `<div class="page">
      ${card("Connection", "link", `
        <div class="grid-2">
          <div class="field"><label>Base URL</label>${block("v-base", base)}</div>
          <div class="field"><label>API key</label>${block("v-key", key)}</div>
        </div>`)}

      ${card("curl", "logs", block("v-curl",
`curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"hello"}]}'`))}

      ${card("Python (openai SDK)", "logs", block("v-py",
`from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="${key}")

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.choices[0].message.content)`))}

      ${card("Node (openai SDK)", "logs", block("v-node",
`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: "${key}",
});

const resp = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "hello" }],
});`))}

      ${card("Environment variables", "settings", block("v-env",
`OPENAI_BASE_URL=${base}
OPENAI_API_KEY=${key}`))}

      ${card("Cursor / Continue", "settings", `
        <p style="margin:0 0 10px;color:var(--text-dim);font-size:12.5px">
          In the provider settings choose an OpenAI-compatible provider, then set:</p>
        ${block("v-ide", `Base URL: ${base}\nAPI Key:  ${key}\nModel:    ${model}`)}
        <div class="note" style="margin-top:12px">${icon("warning", 16)}
          <span>Streaming works, but failover is only transparent before the first token.
          After output starts, a failure ends the stream rather than silently
          contradicting what you already received.</span></div>`)}

      ${card("Available models", "hub",
        `<div class="pills">${(s?.gateway.models ?? []).map((m) => `<span class="pill">${esc(m)}</span>`).join("") || "<span class='empty'>None configured.</span>"}</div>`)}
    </div>`;

    host.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-copytext]");
      if (btn) copy(host.querySelector(`#${btn.dataset.copytext}`).textContent);
    });

    return {};
  },
};
