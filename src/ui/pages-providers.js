/*
 * Add Provider — one collapsible section per service.
 *
 * Only Custom is open by default; everything else is a header you click to
 * expand. The previous version stacked every form on one page, which made a
 * long scroll where nothing was findable.
 */

import { card, compact, confirmDialog, copy, del, esc, get, modal, post, toast } from "./core.js";
import { icon } from "./icons.js";

const PROVIDER_ICON = {
  custom: "settings",
  gemini: "spark",
  openai: "hub",
  openrouter: "link",
  antigravity: "bolt",
  codex: "personAdd",
};

/** Providers whose sign-in button runs a real OAuth flow. */
const OAUTH_READY = new Set(["codex", "openai", "antigravity"]);

/** Which sections start open. Custom first, per the brief. */
const DEFAULT_OPEN = new Set(["custom"]);

export const addProvider = {
  title: "Add Provider",
  subtitle: "Connect API keys or sign in — each provider in its own section",

  mount(host, ctx) {
    host.innerHTML = `<div class="page">
      <div class="prov-toolbar">
        <div class="prov-summary" id="prov-summary"></div>
        <div style="display:flex;gap:8px">
          <button class="btn-sm" id="prov-expand">${icon("chevron", 14)} Expand all</button>
          <button class="btn-sm btn-primary" id="prov-testall">${icon("play", 15)} Test all</button>
        </div>
      </div>
      <div id="prov-results"></div>
      <div class="prov-list" id="prov-list"><div class="empty">Loading providers…</div></div>
    </div>`;

    const open = new Set(DEFAULT_OPEN);
    let catalogue = [];
    let webCatalogue = [];
    let oauthPoll = null;

    const stopPoll = () => {
      if (oauthPoll) clearInterval(oauthPoll);
      oauthPoll = null;
    };

    /* ------------------------------------------------------- rendering */

    const statusChip = (p) => {
      if (p.connected === 0) return `<span class="tag">not connected</span>`;
      if (p.healthy === p.connected) {
        return `<span class="tag active"><i></i>${p.healthy} connected</span>`;
      }
      return `<span class="tag cooling"><i></i>${p.healthy}/${p.connected} healthy</span>`;
    };

    const credRow = (p, cred) => `
      <div class="prov-cred">
        <span class="tag ${esc(cred.effectiveState)}"><i></i></span>
        <span class="prov-cred-name">${esc(cred.name)}</span>
        <span class="prov-cred-meta">${esc(cred.lastError ?? "")}</span>
        <span class="prov-cred-test" data-credtest="${cred.id}"></span>
        <input class="prov-cred-vm" data-vm="${cred.id}"
               value="${esc(cred.validationModel ?? "")}"
               placeholder="validation model"
               title="Model used to verify this credential. Blank uses the first available." />
        <button class="btn-sm" data-adv="${cred.id}" title="Advanced settings">${icon("settings", 13)}</button>
        ${cred.providerType === "openai_custom"
          ? `<button class="btn-sm" data-redetect="${cred.id}" title="Re-detect the endpoint URL">${icon("search", 13)}</button>`
          : ""}
        <button class="btn-sm" data-testone="${cred.id}" title="Test this credential">${icon("play", 13)}</button>
        <button class="btn-sm btn-danger" data-delcred="${p.id}:${cred.id}" title="Remove">${icon("trash", 13)}</button>
      </div>`;

    const keyForm = (p) => {
      if (!p.auth.includes("api_key")) return "";
      return `
        <div class="field">
          <label>${p.multiKey ? "API keys — one per line" : "API key"}</label>
          ${p.multiKey
            ? `<textarea data-keys="${p.id}" placeholder="${esc(p.keyHint)}\n${esc(p.keyHint)}" style="min-height:76px"></textarea>`
            : `<input data-keys="${p.id}" type="password" placeholder="${esc(p.keyHint)}" />`}
          <span class="help">
            Endpoint is preset to <code>${esc(p.baseUrl)}</code>.
            ${p.keyUrl ? `<a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">Get a key ${icon("external", 11)}</a>` : ""}
          </span>
        </div>
        <div class="prov-actions">
          <button class="btn-primary btn-sm" data-addkeys="${p.id}">${icon("add", 15)} Add ${p.multiKey ? "key(s)" : "key"}</button>
          <button class="btn-sm" data-testprov="${p.id}">${icon("play", 15)} Test connection</button>
          ${p.connected && p.listsModels
            ? `<button class="btn-sm" data-fetchmodels="${p.id}">${icon("refresh", 15)} Fetch models</button>`
            : ""}
          ${p.connected ? `<button class="btn-sm btn-danger" data-prune="${p.id}">${icon("trash", 14)} Remove failed</button>` : ""}
        </div>`;
    };

    const oauthForm = (p) => {
      if (!p.auth.includes("oauth")) return "";
      const warn = p.id === "codex"
        ? `<div class="note warn" style="margin-bottom:10px">${icon("warning", 15)}
             <span><b>Use a fresh private window.</b> An existing ChatGPT session signs in
             silently as that account. Also: free plans are refused by the Codex backend
             for every model — this needs a paid plan.</span></div>`
        : p.id === "antigravity"
          ? `<div class="note warn" style="margin-bottom:10px">${icon("warning", 15)}
               <span><b>Use a fresh private window per Google account.</b> Sign-in also
               provisions a Cloud Code project if the account has none, and the model list
               is discovered from the account afterwards.</span></div>`
          : "";
      return `
        ${p.auth.includes("api_key") ? `<div class="prov-divider"><span>or sign in</span></div>` : ""}
        ${warn}
        <div class="field-row">
          <div class="field">
            <label>Name for this connection</label>
            <input data-oauthname="${p.id}" placeholder="Optional" maxlength="60" />
          </div>
          <button class="btn-sm btn-primary" data-oauth="${p.id}">${icon("link", 15)} Sign in with ${esc(p.label)}</button>
        </div>
        ${/* OAuth-only providers get their test button here; API-key providers
             already have one in the key form above. */ ""}
        ${p.connected && !p.auth.includes("api_key")
          ? `<div class="prov-actions">
               <button class="btn-sm" data-testprov="${p.id}">${icon("play", 15)} Test connection</button>
               <button class="btn-sm btn-danger" data-prune="${p.id}">${icon("trash", 14)} Remove failed</button>
             </div>`
          : ""}
        <div data-oauthstatus="${p.id}"></div>`;
    };

    const customForm = (p) => `
      <div class="grid-2">
        <div class="field">
          <label>Name</label>
          <input data-cname placeholder="e.g. Groq" maxlength="60" />
        </div>
        <div class="field">
          <label>Base URL</label>
          <input data-curl placeholder="https://api.groq.com/openai/v1" />
          <span class="help">
            Paste anything from the provider — the endpoint is detected for you.
          </span>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>API key</label>
          <input data-ckey type="password" placeholder="Optional for local endpoints" />
        </div>
        <div class="field">
          <label>Models — one per line</label>
          <textarea data-cmodels placeholder="llama-3.3-70b&#10;mixtral-8x7b" style="min-height:60px"></textarea>
        </div>
      </div>
      <div class="prov-actions">
        <button class="btn-primary btn-sm" data-addcustom>${icon("add", 15)} Add provider</button>
        <button class="btn-sm" data-detect>${icon("search", 15)} Detect endpoint</button>
        ${p.connected ? `<button class="btn-sm" data-testprov="${p.id}">${icon("play", 15)} Test connection</button>` : ""}
        ${p.connected ? `<button class="btn-sm" data-fetchmodels="${p.id}">${icon("refresh", 15)} Fetch models</button>` : ""}
      </div>
      <div id="detect-out"></div>`;

    const section = (p) => {
      const isOpen = open.has(p.id);
      return `
        <section class="prov ${isOpen ? "open" : ""}" data-prov="${p.id}">
          <button class="prov-head" data-toggle="${p.id}">
            <span class="prov-chev">${icon("chevron", 15)}</span>
            <span class="prov-icon">${icon(PROVIDER_ICON[p.id] ?? "hub", 17)}</span>
            <span class="prov-title">
              <span class="prov-name">${esc(p.label)}</span>
              <span class="prov-blurb">${esc(p.blurb)}</span>
            </span>
            ${statusChip(p)}
          </button>
          <div class="prov-body">
            ${p.credentials.length
              ? `<div class="prov-creds">${p.credentials.map((cr) => credRow(p, cr)).join("")}</div>`
              : ""}
            ${p.id === "custom" ? customForm(p) : keyForm(p) + oauthForm(p)}
          </div>
        </section>`;
    };

    /** A cookie/session provider: instructions panel, then the credential box. */
    const webSection = (p) => {
      const isOpen = open.has(p.id);
      const chip = !p.implemented
        ? `<span class="tag" style="opacity:.6">not supported yet</span>`
        : p.connected === 0
          ? `<span class="tag">not connected</span>`
          : p.healthy === p.connected
            ? `<span class="tag active"><i></i>${p.healthy} connected</span>`
            : `<span class="tag cooling"><i></i>${p.healthy}/${p.connected} healthy</span>`;

      return `
        <section class="prov ${isOpen ? "open" : ""} ${p.implemented ? "" : "prov-disabled"}"
                 data-prov="${p.id}">
          <button class="prov-head" data-toggle="${p.id}">
            <span class="prov-chev">${icon("chevron", 15)}</span>
            <span class="prov-icon">${icon("cloud", 17)}</span>
            <span class="prov-title">
              <span class="prov-name">${esc(p.label)}</span>
              <span class="prov-blurb">${esc(p.blurb)}</span>
            </span>
            ${chip}
          </button>
          <div class="prov-body">
            ${p.credentials.length
              ? `<div class="prov-creds">${p.credentials.map((cr) => credRow(p, cr)).join("")}</div>`
              : ""}

            <div class="cookie-help">
              <div class="cookie-help-head">${icon("shield", 15)} How to get the session credential</div>
              <div class="cookie-help-cred">Required: <code>${esc(p.credentialName)}</code></div>
              <ol>${p.instructions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
              ${p.note ? `<p class="cookie-help-note">${esc(p.note)}</p>` : ""}
              <p class="cookie-help-warn">
                Treat this like a password — it can usually act as the whole signed-in
                account until it expires or you sign out everywhere.
              </p>
              <a href="${esc(p.website)}" target="_blank" rel="noopener">
                Open ${esc(p.website)} ${icon("external", 11)}</a>
            </div>

            ${p.implemented || p.id === "gemini-web"
              ? `<div class="field">
                   <label>Session credential</label>
                   <div class="field-row">
                     <input data-web="${p.id}" type="password" placeholder="${esc(p.placeholder)}" />
                     <button class="btn-sm" data-checkcookie="${p.id}">${icon("check", 14)} Check</button>
                   </div>
                   <span class="help">Only the value is stored — the rest of a pasted
                     Cookie header is discarded.</span>
                   <div data-checkout="${p.id}"></div>
                 </div>
                 <div class="field-row">
                   <div class="field">
                     <label>Name</label>
                     <input data-webname="${p.id}" placeholder="Optional" maxlength="60" />
                   </div>
                   <button class="btn-sm btn-primary" data-addweb="${p.id}">
                     ${icon("add", 15)} Add session</button>
                   ${p.connected ? `<button class="btn-sm" data-testprov="${p.id}">${icon("play", 15)} Test</button>` : ""}
                 </div>`
              : `<div class="note warn">${icon("warning", 15)}
                   <span>No transport for this provider yet, so a credential would sit
                   unused. It is listed so you can see what is and is not supported.</span></div>`}
          </div>
        </section>`;
    };

    const render = () => {
      host.querySelector("#prov-list").innerHTML =
        catalogue.map(section).join("") +
        (webCatalogue.length
          ? `<div class="prov-group-head">Web session providers</div>` +
            webCatalogue.map(webSection).join("")
          : "");

      const connected = catalogue.reduce((n, p) => n + p.connected, 0);
      const healthy = catalogue.reduce((n, p) => n + p.healthy, 0);
      host.querySelector("#prov-summary").innerHTML =
        `<b>${connected}</b> connection${connected === 1 ? "" : "s"} across ` +
        `<b>${catalogue.filter((p) => p.connected).length}</b> provider(s) · ` +
        `<span style="color:var(--ok)">${healthy} healthy</span>`;
    };

    const load = async () => {
      try {
        const [main, web] = await Promise.all([
          get("/admin/providers/catalogue"),
          get("/admin/providers/web/catalogue"),
        ]);
        catalogue = main.providers;
        webCatalogue = web.providers;
        render();
      } catch (err) {
        host.querySelector("#prov-list").innerHTML =
          `<div class="note bad">${icon("error", 16)}<span>${esc(err.message)}</span></div>`;
      }
    };

    /* --------------------------------------------------------- testing */

    const showResults = (payload) => {
      const box = host.querySelector("#prov-results");
      const groups = payload.providers ?? [
        { id: payload.provider, label: payload.provider, tested: payload.tested, passed: payload.passed, results: payload.results },
      ];

      box.innerHTML = `
        <section class="card test-report">
          <div class="card-head">
            <div class="card-head-text">
              <h2>${icon("health", 17)} Test report</h2>
              <p class="sub">${payload.passed} of ${payload.tested} replied. Only credentials that
                 answered are kept in rotation.</p>
            </div>
            <button class="btn-sm" id="prov-clearresults">${icon("close", 14)}</button>
          </div>
          ${groups.map((g) => `
            <div class="test-group">
              <div class="test-group-head">
                <span>${esc(g.label ?? g.id)}</span>
                <span class="tag ${g.passed === g.tested ? "active" : g.passed ? "cooling" : "dead"}">
                  <i></i>${g.passed}/${g.tested}</span>
              </div>
              ${g.results.map((r) => `
                <div class="test-line ${r.ok ? "ok" : "bad"}">
                  ${icon(r.ok ? "check" : "close", 14)}
                  <span class="test-name">${esc(r.name)}</span>
                  <span class="test-detail">${esc((r.reply ?? r.message ?? "").slice(0, 110))}</span>
                  <span class="test-ms">${r.latencyMs}ms</span>
                </div>`).join("")}
            </div>`).join("")}
        </section>`;

      box.querySelector("#prov-clearresults").addEventListener("click", () => (box.innerHTML = ""));
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    const runTest = async (url, btn, label) => {
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `${icon("refresh", 15, "spin")} Testing…`;
      try {
        const payload = await post(url, {});
        if (payload.tested === 0) {
          toast(`No credentials to test for ${label}.`, "bad");
        } else {
          showResults(payload);
          toast(`${payload.passed} of ${payload.tested} replied`, payload.passed ? "ok" : "bad");
        }
        await load();
        await ctx.refresh();
      } catch (err) {
        toast(err.message, "bad");
      } finally {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    };

    /* ---------------------------------------------------------- events */

    host.querySelector("#prov-expand").addEventListener("click", (e) => {
      const all = catalogue.length && open.size === catalogue.length;
      open.clear();
      if (!all) for (const p of catalogue) open.add(p.id);
      e.currentTarget.innerHTML = `${icon("chevron", 14)} ${all ? "Expand all" : "Collapse all"}`;
      render();
    });

    host.querySelector("#prov-testall").addEventListener("click", async (e) => {
      const total = catalogue.reduce((n, p) => n + p.connected, 0);
      if (total === 0) return toast("Nothing connected yet.", "bad");
      const ok = await confirmDialog(
        "Test every connection",
        `This sends a real message through each of the ${total} connections, one at a time. ` +
          `Each test spends a request from that credential's quota.`,
        `Test ${total}`,
      );
      if (!ok) return;
      await runTest("/admin/providers/test-all", e.currentTarget, "the pool");
    });

    // Saved on blur rather than per keystroke.
    host.addEventListener(
      "change",
      async (e) => {
        if (!e.target.dataset?.vm) return;
        try {
          await post(`/admin/providers/credentials/${e.target.dataset.vm}/validation-model`, {
            model: e.target.value,
          });
          toast(e.target.value.trim() ? "Validation model saved" : "Validation model cleared");
        } catch (err) {
          toast(err.message, "bad");
        }
      },
      true,
    );

    host.addEventListener("click", async (e) => {
      const t = (name) => e.target.closest(`[data-${name}]`);

      const copyAuth = t("copyauth");
      if (copyAuth) {
        await copy(copyAuth.dataset.copyauth ?? "", "Sign-in link copied");
        return;
      }

      const toggle = t("toggle");
      if (toggle) {
        const id = toggle.dataset.toggle;
        open.has(id) ? open.delete(id) : open.add(id);
        render();
        return;
      }

      const addKeys = t("addkeys");
      if (addKeys) {
        const id = addKeys.dataset.addkeys;
        const input = host.querySelector(`[data-keys="${id}"]`);
        const keys = input?.value?.trim();
        if (!keys) return toast("Paste at least one key.", "bad");

        addKeys.disabled = true;
        try {
          const res = await post(`/admin/providers/${id}/keys`, { keys });
          if (res.added.length) toast(`Added ${res.added.length} key(s)`);
          for (const s of res.skipped) toast(`${s.key}: ${s.reason}`, "bad");
          if (res.added.length) {
            input.value = "";
            open.add(id);
            await load();
            await ctx.refresh();
            // Adding a key you cannot verify is not much use, so probe at once.
            const btn = host.querySelector(`[data-testprov="${id}"]`);
            if (btn) await runTest(`/admin/providers/${id}/test`, btn, id);
          }
        } catch (err) {
          toast(err.message, "bad");
        } finally {
          addKeys.disabled = false;
        }
        return;
      }

      const addWeb = t("addweb");
      if (addWeb) {
        const id = addWeb.dataset.addweb;
        const input = host.querySelector(`[data-web="${id}"]`);
        const value = input?.value?.trim();
        if (!value) return toast("Paste the session credential first.", "bad");

        addWeb.disabled = true;
        try {
          await post(`/admin/providers/web/${id}/session`, {
            value,
            label: host.querySelector(`[data-webname="${id}"]`)?.value ?? "",
          });
          input.value = "";
          toast("Session added");
          open.add(id);
          await load();
          await ctx.refresh();
          // A session you cannot verify is not worth much, so probe at once.
          const btn = host.querySelector(`[data-testprov="${id}"]`);
          if (btn) await runTest(`/admin/providers/${id}/test`, btn, id);
        } catch (err) {
          toast(err.message, "bad");
        } finally {
          addWeb.disabled = false;
        }
        return;
      }

      const addCustom = t("addcustom");
      if (addCustom) {
        addCustom.disabled = true;
        const addLabel = addCustom.innerHTML;
        addCustom.innerHTML = `${icon("refresh", 15, "spin")} Detecting…`;
        try {
          const res = await post("/admin/providers/custom", {
            name: host.querySelector("[data-cname]").value,
            baseUrl: host.querySelector("[data-curl]").value,
            apiKey: host.querySelector("[data-ckey]").value,
            models: host.querySelector("[data-cmodels]").value,
          });
          toast(
            res.detection?.baseUrl && res.detection.baseUrl !== host.querySelector("[data-curl]").value.trim()
              ? `Added — endpoint resolved to ${res.detection.baseUrl}`
              : "Provider added",
          );
          for (const sel of ["[data-cname]", "[data-curl]", "[data-ckey]", "[data-cmodels]"]) {
            host.querySelector(sel).value = "";
          }
          await load();
          await ctx.refresh();
        } catch (err) {
          // Detection failures come back with the full candidate log attached.
          const out = host.querySelector("#detect-out");
          if (out && err.detection) showDetection(out, err.detection);
          else toast(err.message, "bad");
        } finally {
          addCustom.disabled = false;
          addCustom.innerHTML = addLabel;
        }
        return;
      }

      const testProv = t("testprov");
      if (testProv) {
        await runTest(`/admin/providers/${testProv.dataset.testprov}/test`, testProv, testProv.dataset.testprov);
        return;
      }

      const testOne = t("testone");
      if (testOne) {
        const id = testOne.dataset.testone;
        const cell = host.querySelector(`[data-credtest="${id}"]`);
        if (cell) cell.textContent = "testing…";
        try {
          const r = await post(`/admin/credentials/${id}/test`, {});
          if (cell) {
            cell.textContent = r.ok ? `ok · ${r.latencyMs}ms` : (r.code ?? "failed");
            cell.style.color = r.ok ? "var(--ok)" : "var(--bad)";
            cell.title = r.reply ?? r.message ?? "";
          }
          toast(r.ok ? `${r.name} replied in ${r.latencyMs}ms` : `${r.name}: ${r.message}`, r.ok ? "ok" : "bad");
          await ctx.refresh();
        } catch (err) {
          toast(err.message, "bad");
        }
        return;
      }

      /** Render a detection outcome, including the candidates that were tried. */
      const showDetection = (el, d) => {
        if (!el) return;
        el.innerHTML = `<div class="test-result ${d.ok ? "ok" : "bad"}">
          <div class="test-row">${icon(d.ok ? "check" : "error", 15)}<span>${esc(d.message)}</span></div>
          ${d.attempts?.length
            ? `<details style="margin-top:8px">
                 <summary style="cursor:pointer;font-size:11.5px;color:var(--text-faint)">
                   ${d.attempts.length} candidate(s) tried</summary>
                 <div class="test-reply" style="max-height:11rem;overflow:auto">${d.attempts
                   .map((a) => `${esc(String(a.status)).padEnd(5)} ${esc(a.url)} — ${esc(a.note)}`)
                   .join("<br>")}</div>
               </details>`
            : ""}
        </div>`;
      };

      const detect = t("detect");
      if (detect) {
        const out = host.querySelector("#detect-out");
        const url = host.querySelector("[data-curl]").value.trim();
        if (!url) return toast("Enter a URL first.", "bad");

        detect.disabled = true;
        const original = detect.innerHTML;
        detect.innerHTML = `${icon("refresh", 15, "spin")} Detecting…`;
        try {
          const d = await post("/admin/providers/detect", {
            baseUrl: url,
            apiKey: host.querySelector("[data-ckey]").value,
          });
          showDetection(out, d);
          if (d.ok) {
            // Put the corrected URL back in the field so it is obvious what
            // will be saved.
            host.querySelector("[data-curl]").value = d.baseUrl;
            if (d.models.length && !host.querySelector("[data-cmodels]").value.trim()) {
              host.querySelector("[data-cmodels]").value = d.models.join("\n");
            }
          }
        } catch (err) {
          toast(err.message, "bad");
        } finally {
          detect.disabled = false;
          detect.innerHTML = original;
        }
        return;
      }

      const adv = t("adv");
      if (adv) {
        const id = Number(adv.dataset.adv);
        const cred =
          catalogue.flatMap((p) => p.credentials).find((c) => c.id === id) ??
          webCatalogue.flatMap((p) => p.credentials).find((c) => c.id === id);
        if (!cred) return;

        const saved = await modal({
          title: `Advanced — ${cred.name}`,
          width: "48rem",
          body: `
            <div class="adv-models">
              <div class="adv-models-head">
                <span>Available models</span>
                <span class="adv-filters">
                  <button class="btn-sm" data-mfilter="all">All</button>
                  <button class="btn-sm" data-mfilter="ok">Working</button>
                  <button class="btn-sm" data-mfilter="failed">Failed</button>
                  <button class="btn-sm" data-mfilter="hidden">Hidden</button>
                </span>
              </div>
              <div class="adv-models-actions">
                <button class="btn-sm btn-primary" id="m-testall">${icon("play", 14)} Test all models</button>
                <button class="btn-sm btn-danger" id="m-prune">${icon("eyeOff", 14)} Hide failed</button>
                <span class="adv-models-count" id="m-count"></span>
              </div>
              <input id="m-search" placeholder="Filter models…" style="margin:8px 0" />
              <div class="adv-models-list" id="m-list"><div class="empty">Loading…</div></div>
            </div>
            <div class="prov-divider"><span>connection settings</span></div>
            <div class="grid-2">
              <div class="field">
                <label>Priority</label>
                <input id="a-priority" type="number" min="1" max="999" value="${cred.priority ?? 1}" />
                <span class="help">Lower runs first. Everything at 1 is exhausted before 2 is touched.</span>
              </div>
              <div class="field">
                <label>Custom User-Agent</label>
                <input id="a-ua" value="${esc(cred.customUserAgent ?? "")}" placeholder="leave blank for the default" />
                <span class="help">Web sessions pinned to a browser fingerprint need the exact UA.</span>
              </div>
            </div>
            <div class="field">
              <label>Excluded models — one per line</label>
              <textarea id="a-excluded" style="min-height:60px">${esc((cred.excludedModels ?? []).join("\n"))}</textarea>
              <span class="help">Never route these here, even if this connection could serve them.</span>
            </div>
            <div class="field">
              <label>Routing tags — comma separated</label>
              <input id="a-tags" value="${esc((cred.routingTags ?? []).join(", "))}" placeholder="none" />
              <span class="help">Tagged connections are reserved: they only serve requests sending a
                matching <code>x-ai-auther-tags</code> header. Untagged serves everything.</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="a-permodel" ${cred.perModelQuota ? "checked" : ""} />
              <span class="switch-track"></span>
              <span>Per-model quota — a 429/404 benches only that model, not the whole connection</span>
            </label>`,
          footer: `<button data-close>Cancel</button><button class="btn-primary" data-save>Save</button>`,
          onMount: (root, close) => {
            let models = [];
            let filter = "all";

            const paint = () => {
              const q = root.querySelector("#m-search").value.trim().toLowerCase();
              const shown = models.filter((m) => {
                if (q && !m.id.toLowerCase().includes(q)) return false;
                if (filter === "ok") return m.stat?.ok;
                if (filter === "failed") return m.stat && !m.stat.ok;
                if (filter === "hidden") return m.excluded;
                return true;
              });

              const ok = models.filter((m) => m.stat?.ok).length;
              const bad = models.filter((m) => m.stat && !m.stat.ok).length;
              root.querySelector("#m-count").textContent =
                `${models.length} total · ${ok} working · ${bad} failed · ` +
                `${models.filter((m) => m.excluded).length} hidden`;

              root.querySelector("#m-list").innerHTML = shown.length
                ? shown.map((m) => `
                    <div class="adv-model ${m.excluded ? "hidden-model" : ""}">
                      <span class="adv-model-dot ${m.stat ? (m.stat.ok ? "ok" : "bad") : ""}"></span>
                      <span class="adv-model-id">${esc(m.id)}</span>
                      ${m.free ? "" : `<span class="tag">paid</span>`}
                      <span class="adv-model-stat">${
                        m.stat ? (m.stat.ok ? `${m.stat.latencyMs}ms` : esc((m.stat.error ?? "failed").slice(0, 40))) : "untested"
                      }</span>
                      <button class="btn-sm" data-mtest="${esc(m.id)}" title="Test this model">${icon("play", 12)}</button>
                      <button class="btn-sm" data-mtoggle="${esc(m.id)}" title="${m.excluded ? "Show" : "Hide"}">
                        ${icon(m.excluded ? "eyeOff" : "eye", 12)}</button>
                    </div>`).join("")
                : `<div class="empty">No models match.</div>`;
            };

            const loadModels = async () => {
              try {
                models = (await get(`/admin/providers/credentials/${id}/models`)).models;
                paint();
              } catch (err) {
                root.querySelector("#m-list").innerHTML =
                  `<div class="note bad">${icon("error", 14)}<span>${esc(err.message)}</span></div>`;
              }
            };

            root.querySelector("#m-search").addEventListener("input", paint);

            root.addEventListener("click", async (ev) => {
              const f = ev.target.closest("[data-mfilter]");
              if (f) {
                filter = f.dataset.mfilter;
                root.querySelectorAll("[data-mfilter]").forEach((b) =>
                  b.classList.toggle("btn-primary", b.dataset.mfilter === filter),
                );
                return paint();
              }

              const one = ev.target.closest("[data-mtest]");
              if (one) {
                one.disabled = true;
                try {
                  const r = await post(`/admin/providers/credentials/${id}/models/test`, {
                    models: [one.dataset.mtest],
                  });
                  toast(r.passed ? `${one.dataset.mtest} ok` : `${one.dataset.mtest} failed`, r.passed ? "ok" : "bad");
                  await loadModels();
                } finally {
                  one.disabled = false;
                }
                return;
              }

              const tgl = ev.target.closest("[data-mtoggle]");
              if (tgl) {
                const model = tgl.dataset.mtoggle;
                const entry = models.find((m) => m.id === model);
                const next = models
                  .filter((m) => (m.id === model ? !entry.excluded : m.excluded))
                  .map((m) => m.id);
                await post(`/admin/providers/credentials/${id}/advanced`, { excludedModels: next });
                await loadModels();
                return;
              }

              if (ev.target.closest("#m-testall")) {
                const btn = ev.target.closest("#m-testall");
                btn.disabled = true;
                btn.innerHTML = `${icon("refresh", 14, "spin")} Testing…`;
                try {
                  // Sequential and capped server-side — a provider with 337
                  // models would otherwise be one enormous request.
                  const r = await post(`/admin/providers/credentials/${id}/models/test`, {});
                  toast(
                    `${r.passed}/${r.tested} models replied` + (r.skipped ? ` (${r.skipped} not tested)` : ""),
                    r.passed ? "ok" : "bad",
                  );
                  await loadModels();
                } catch (err) {
                  toast(err.message, "bad");
                } finally {
                  btn.disabled = false;
                  btn.innerHTML = `${icon("play", 14)} Test all models`;
                }
                return;
              }

              if (ev.target.closest("#m-prune")) {
                const r = await post(`/admin/providers/credentials/${id}/models/prune`, {});
                toast(r.removed ? `Hid ${r.removed} failed model(s)` : "Nothing to hide");
                await loadModels();
              }
            });

            root.querySelector("[data-save]").addEventListener("click", () =>
              close({
                priority: Number(root.querySelector("#a-priority").value),
                customUserAgent: root.querySelector("#a-ua").value,
                excludedModels: root.querySelector("#a-excluded").value,
                routingTags: root.querySelector("#a-tags").value,
                perModelQuota: root.querySelector("#a-permodel").checked,
              }),
            );

            loadModels();
          },
        });
        if (!saved) return;

        try {
          await post(`/admin/providers/credentials/${id}/advanced`, saved);
          toast("Settings saved");
          await load();
          await ctx.refresh();
        } catch (err) {
          toast(err.message, "bad");
        }
        return;
      }

      const checkCookie = t("checkcookie");
      if (checkCookie) {
        const id = checkCookie.dataset.checkcookie;
        const value = host.querySelector(`[data-web="${id}"]`)?.value?.trim();
        if (!value) return toast("Paste the credential first.", "bad");

        const out = host.querySelector(`[data-checkout="${id}"]`);
        const original = checkCookie.innerHTML;
        checkCookie.disabled = true;
        checkCookie.innerHTML = `${icon("refresh", 14, "spin")} Checking…`;
        try {
          const r = await post(`/admin/providers/web/${id}/check`, { value });
          out.innerHTML = `<div class="test-result ${r.ok ? "ok" : "bad"}">
            <div class="test-row">${icon(r.ok ? "check" : "error", 15)}
              <span>${esc(r.message)}${r.latencyMs ? ` · ${r.latencyMs}ms` : ""}</span></div></div>`;
        } catch (err) {
          out.innerHTML = `<div class="test-result bad"><div class="test-row">
            ${icon("error", 15)}<span>${esc(err.message)}</span></div></div>`;
        } finally {
          checkCookie.disabled = false;
          checkCookie.innerHTML = original;
        }
        return;
      }

      const redetect = t("redetect");
      if (redetect) {
        const id = redetect.dataset.redetect;
        redetect.disabled = true;
        try {
          const r = await post(`/admin/providers/credentials/${id}/redetect`, {});
          if (r.ok) {
            toast(`Endpoint corrected to ${r.to}`);
            await load();
            await ctx.refresh();
          } else {
            toast(r.detection?.message ?? "Could not detect an endpoint.", "bad");
          }
        } catch (err) {
          toast(err.message, "bad");
        } finally {
          redetect.disabled = false;
        }
        return;
      }

      const fetchModels = t("fetchmodels");
      if (fetchModels) {
        const id = fetchModels.dataset.fetchmodels;
        const original = fetchModels.innerHTML;
        fetchModels.disabled = true;
        fetchModels.innerHTML = `${icon("refresh", 15, "spin")} Fetching…`;
        try {
          // save=1 stores the list, so it drives both the chat picker and
          // routing rather than being a one-off display.
          const res = await get(`/admin/providers/${id}/models?save=1`);
          if (res.models.length) {
            toast(`${res.models.length} models discovered and saved`);
          } else {
            toast(res.message ?? "That endpoint returned no model list", "bad");
          }
          await load();
        } catch (err) {
          toast(err.message, "bad");
        } finally {
          fetchModels.disabled = false;
          fetchModels.innerHTML = original;
        }
        return;
      }

      const prune = t("prune");
      if (prune) {
        const id = prune.dataset.prune;
        const ok = await confirmDialog(
          "Remove failed credentials",
          `Delete every ${id} credential currently marked dead. Their stored keys are erased.`,
          "Remove",
        );
        if (!ok) return;
        const res = await post(`/admin/providers/${id}/prune`, {});
        toast(`Removed ${res.removed}`);
        await load();
        await ctx.refresh();
        return;
      }

      const delCred = t("delcred");
      if (delCred) {
        const [pid, cid] = delCred.dataset.delcred.split(":");
        const ok = await confirmDialog("Remove connection", "Its stored key is deleted.", "Remove");
        if (!ok) return;
        await del(`/admin/providers/${pid}/credentials/${cid}`);
        toast("Removed");
        await load();
        await ctx.refresh();
        return;
      }

      const oauth = t("oauth");
      if (oauth) {
        const id = oauth.dataset.oauth;
        if (!OAUTH_READY.has(id)) {
          toast(`${id} sign-in is not implemented yet — paste an API key instead.`, "bad");
          return;
        }
        // "Sign in with OpenAI" is the Codex connector, offered from the
        // OpenAI section as well as its own. Antigravity is its own flow.
        const flow = id === "antigravity" ? "antigravity" : "codex";
        const statusEl = host.querySelector(`[data-oauthstatus="${id}"]`);
        const name = host.querySelector(`[data-oauthname="${id}"]`)?.value?.trim() ?? "";

        oauth.disabled = true;
        stopPoll();
        try {
          const session = await post("/admin/auth/login", { name, provider: flow });
          statusEl.innerHTML = `<div class="note">${icon("clock", 15)}
            <div style="min-width:0">
              <div>Waiting for the browser…</div>
              <div class="copyrow" style="margin-top:8px">
                <div class="code">${esc(session.authorizeUrl)}</div>
                <button class="btn-sm" data-copyauth="${esc(session.authorizeUrl)}" title="Copy sign-in link">
                  ${icon("copy", 14)} Copy link
                </button>
              </div>
              <a class="btn btn-sm btn-primary" style="margin-top:8px"
                 href="${esc(session.authorizeUrl)}" target="_blank" rel="noopener">
                 ${icon("external", 14)} Open sign-in</a>
            </div></div>`;

          oauthPoll = setInterval(async () => {
            try {
              const s = await get(`/admin/auth/login/${session.id}`);
              if (s.state === "pending") return;
              stopPoll();
              oauth.disabled = false;
              if (s.state === "complete") {
                statusEl.innerHTML = `<div class="note ok">${icon("check", 15)}<span>Connected.</span></div>`;
                await load();
                await ctx.refresh();
              } else {
                statusEl.innerHTML = `<div class="note ${s.duplicate ? "warn" : "bad"}">
                  ${icon("warning", 15)}<span>${esc(s.error ?? "Sign-in failed.")}</span></div>`;
              }
            } catch {
              stopPoll();
              oauth.disabled = false;
            }
          }, 1500);
        } catch (err) {
          oauth.disabled = false;
          statusEl.innerHTML = `<div class="note bad">${icon("error", 15)}<span>${esc(err.message)}</span></div>`;
        }
      }
    });

    load();
    return { destroy: stopPoll };
  },
};
