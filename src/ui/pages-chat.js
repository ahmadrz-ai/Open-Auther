/* Chat playground: conversation list, message thread, composer. */

import { compact, confirmDialog, del, esc, get, post, state, toast } from "./core.js";
import { icon } from "./icons.js";

/** Capability flag -> icon and label shown under the composer. */
const CAP_ICONS = [
  ["reasoning", "bolt", "Thinking / reasoning effort"],
  ["vision", "eye", "Image input"],
  ["tools", "settings", "Tool calling"],
  ["streaming", "play", "Streaming"],
  ["webSearch", "cloud", "Internet access"],
];

/** Minimal, safe markdown: fenced code, inline code, bold, italics. */
function renderMarkdown(text) {
  const blocks = [];
  let src = String(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push({ lang, code });
    return `[[BLOCK${blocks.length - 1}]]`;
  });

  src = esc(src)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");

  return src.replace(/\[\[BLOCK(\d+)\]\]/g, (_m, i) => {
    const b = blocks[Number(i)];
    if (!b) return "";
    return `<div class="chat-code">
      <div class="chat-code-head"><span>${esc(b.lang || "code")}</span>
        <button class="btn-sm" data-copycode="${esc(b.code)}">${icon("copy", 13)}</button></div>
      <pre>${esc(b.code.replace(/\n$/, ""))}</pre>
    </div>`;
  });
}

export const chat = {
  title: "Chat",
  subtitle: "Test models live through the pool",

  mount(host, ctx) {
    host.innerHTML = `
      <div class="chat-shell">
        <aside class="chat-list">
          <div class="chat-list-head">
            <span>Conversations</span>
            <button class="btn-sm btn-primary" id="c-new">${icon("add", 14)} New</button>
          </div>
          <ul class="list" id="c-items"></ul>
        </aside>

        <section class="chat-main">
          <div class="chat-thread" id="c-thread"></div>

          <div class="chat-composer">
            <div class="chat-controls">
              <label class="chat-ctl">
                <span>Provider</span>
                <select id="c-provider">
                  <option value="all">All Providers</option>
                  <option value="gemini" selected>Gemini API</option>
                  <option value="openai_custom">Custom Providers</option>
                  <option value="codex_oauth">ChatGPT Codex</option>
                </select>
              </label>
              <label class="chat-ctl">
                <span>Model</span>
                <select id="c-model"></select>
              </label>
              <label class="chat-ctl" id="c-effort-wrap">
                <span>Thinking</span>
                <select id="c-effort"></select>
              </label>
              <label class="chat-ctl">
                <span>Connection</span>
                <select id="c-auth"></select>
              </label>
              <div class="chat-caps" id="c-caps"></div>
            </div>

            <div class="chat-attachments" id="c-attachments" hidden></div>

            <div class="chat-input" id="c-dropzone">
              <input type="file" id="c-file" accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif" multiple hidden>
              <button class="btn-attach" id="c-attach" title="Attach an image" aria-label="Attach an image">${icon("plus", 17)}</button>
              <textarea id="c-input" rows="1" placeholder="Send a message, or drop an image here…"></textarea>
              <button class="btn-primary btn-send" id="c-send" title="Send">${icon("chevron", 17)}</button>
              <div class="chat-drophint" id="c-drophint">Drop images to attach</div>
            </div>
            <div class="chat-foot" id="c-foot"></div>
          </div>
        </section>
      </div>`;

    let meta = null;
    let conversations = [];
    let current = null;
    let messages = [];
    let streaming = false;
    let abort = null;

    const el = (id) => host.querySelector(id);

    const VIRTUAL_IDS = new Set(["auto", "fast", "quality"]);

    /* ------------------------------------------------------- rendering */

    const renderCaps = () => {
      const model = el("#c-model").value;
      const entry = meta?.models.find((m) => m.id === model);
      const caps = entry?.capabilities;
      if (!caps) return void (el("#c-caps").innerHTML = "");

      el("#c-caps").innerHTML = CAP_ICONS.map(([key, ico, label]) => {
        const on = caps[key];
        return `<span class="cap ${on ? "on" : "off"}" title="${esc(label)}: ${on ? "available" : "not available"}">
          ${icon(ico, 14)}</span>`;
      }).join("") +
        (caps.contextWindow
          ? `<span class="cap-ctx" title="Context window">${compact(caps.contextWindow)} ctx</span>`
          : "") +
        `<span class="cap-src" title="Capabilities are a curated table, editable in Settings">${esc(caps.source)}</span>`;

      // Thinking level is meaningless for a model that does not accept it.
      el("#c-effort-wrap").style.display = caps.reasoning ? "" : "none";
    };

    const renderList = () => {
      el("#c-items").innerHTML = conversations.length
        ? conversations.map((c) => `
            <li class="chat-item ${current?.id === c.id ? "active" : ""}" data-conv="${c.id}">
              <span class="chat-item-title">${esc(c.title)}</span>
              <span class="chat-item-meta">${esc(c.model || "")} · ${c.messageCount ?? 0} msgs</span>
              <button class="btn-sm btn-icon chat-item-del" data-delconv="${c.id}" title="Delete">${icon("trash", 13)}</button>
            </li>`).join("")
        : `<li class="empty">No conversations yet.</li>`;
    };

    const renderThread = () => {
      const thread = el("#c-thread");
      if (!current) {
        thread.innerHTML = `<div class="chat-blank">
          <h3>Test a model</h3>
          <p>Start a conversation to check that the pool is serving real replies.
             Pick <b>Auto</b> to use normal rotation, or pin a specific Auth to prove that one works.</p>
        </div>`;
        return;
      }
      if (messages.length === 0) {
        thread.innerHTML = `<div class="chat-blank">
          <h3>${esc(current.title)}</h3>
          <p>Send a message to begin.</p></div>`;
        return;
      }

      thread.innerHTML = messages.map((m) => {
        if (m.role === "user") {
          // Images above the caption, matching the order they are sent in.
          const shots = (m.attachments ?? [])
            .map(
              (a) =>
                `<img class="msg-image" src="${a.dataUrl}" alt="${esc(a.name)}" title="${esc(a.name)}">`,
            )
            .join("");
          return `<div class="msg user"><div class="msg-body">
            ${shots ? `<div class="msg-images">${shots}</div>` : ""}
            ${m.content ? renderMarkdown(m.content) : ""}
          </div></div>`;
        }
        const meta = [
          m.credentialName ? `served by ${esc(m.credentialName)}` : null,
          m.model ? `model ${esc(m.model)}` : null,
          m.tokens ? `${compact(m.tokens)} tokens` : null,
          m.latencyMs ? `${m.latencyMs}ms` : null,
        ].filter(Boolean).join(" · ");

        return `<div class="msg assistant">
          <div class="msg-avatar">${icon("spark", 15)}</div>
          <div class="msg-col">
            ${m.content ? `<div class="msg-body">${renderMarkdown(m.content)}</div>` : ""}
            ${m.error ? `<div class="msg-error">${icon("warning", 14)} ${esc(m.error)}</div>` : ""}
            ${meta ? `<div class="msg-meta">${meta}</div>` : ""}
          </div>
        </div>`;
      }).join("");

      thread.scrollTop = thread.scrollHeight;
    };

    /* ---------------------------------------------------------- loading */

    const loadMeta = async () => {
      meta = await get("/admin/chat/meta");

      // Provider list comes from the pool, so only providers you actually have
      // a credential for are offered.
      el("#c-provider").innerHTML =
        `<option value="all">All providers</option>` +
        meta.providers
          .map((p) => `<option value="${esc(p.id)}">${esc(p.label)} (${p.credentials})</option>`)
          .join("");

      /*
       * Model list follows the provider, using the server's own
       * credential-derived mapping.
       *
       * This used to filter by string prefix and, when a provider matched
       * nothing, fall back to listing every model — which is how "Custom
       * Providers" ended up showing a Gemini model that it could never route.
       * An empty provider now says so.
       */
      const updateModelsForProvider = () => {
        const provider = el("#c-provider").value || "all";
        const models = (meta.models ?? []).filter((m) => {
          // Auto/fast/quality are global policies. When a concrete provider is
          // selected, show only that provider's actual model catalogue.
          if (provider !== "all" && VIRTUAL_IDS.has(m.id)) return false;
          return provider === "all" || m.providers.includes(provider);
        });

        const modelSelect = el("#c-model");

        if (models.length === 0) {
          /*
           * A custom endpoint declares nothing until you fetch or type its
           * models, so offer a free-text box rather than a dead dropdown.
           * `.value` reads the same either way, so nothing downstream changes.
           */
          const typed = modelSelect.tagName === "INPUT" ? modelSelect.value : "";
          modelSelect.outerHTML =
            `<input id="c-model" list="c-model-list" placeholder="type a model id" value="${esc(typed)}" />` +
            `<datalist id="c-model-list"></datalist>`;
          el("#c-send").disabled = false;
          renderCaps();
          return;
        }

        // Back to a dropdown if we swapped to an input earlier.
        if (modelSelect.tagName === "INPUT") {
          modelSelect.nextElementSibling?.remove();
          modelSelect.outerHTML = `<select id="c-model"></select>`;
        }

        el("#c-model").disabled = false;
        el("#c-send").disabled = false;
        el("#c-model").innerHTML = models
          .map(
            (m) =>
              `<option value="${esc(m.id)}"${m.available ? "" : " data-unavailable=\"1\""}>` +
              `${esc(m.id)}${m.available ? "" : " (no healthy credential)"}</option>`,
          )
          .join("");

        // Preserve the current model when it is valid; otherwise select the
        // first model in the newly selected provider/policy scope.
        const wanted = current?.model ?? meta.defaultModel;
        const next = models.some((m) => m.id === wanted) ? wanted : models[0].id;
        el("#c-model").value = next;
        if (current && (current.model !== next || current.providerId !== (provider === "all" ? null : provider))) {
          current.model = next;
          current.providerId = provider === "all" ? null : provider;
          void post(`/admin/chat/conversations/${current.id}`, {
            model: next,
            providerId: current.providerId,
          });
        }
        renderCaps();
      };

      /*
       * Delegated, because the model control is swapped between <select> and
       * <input> as providers change — a listener bound to the element itself
       * would be discarded on the first swap.
       */
      host.addEventListener("change", (e) => {
        if (e.target.id !== "c-model") return;
        const entry = meta.models.find((m) => m.id === e.target.value);
        const provider = el("#c-provider").value;
        if (entry && provider !== "all" && !entry.providers.includes(provider)) {
          el("#c-provider").value = entry.providers[0] ?? "all";
        }
        renderCaps();
      });

      el("#c-provider").addEventListener("change", updateModelsForProvider);
      updateModelsForProvider();

      el("#c-effort").innerHTML = meta.reasoningLevels
        .map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
      el("#c-auth").innerHTML =
        `<option value="">Auto (rotation)</option>` +
        meta.auths.map((a) =>
          `<option value="${a.id}">${esc(a.name)}${a.state === "active" ? "" : ` (${a.state})`}</option>`,
        ).join("");

      el("#c-effort").value = meta.defaultReasoning;
      renderCaps();
    };

    /** Point the provider selector at whatever can serve the given model. */
    const syncProviderToModel = (model) => {
      if (VIRTUAL_IDS.has(model)) {
        el("#c-provider").value = "all";
        return;
      }
      const entry = meta?.models?.find((m) => m.id === model);
      if (entry?.providers?.length) el("#c-provider").value = entry.providers[0];
    };

    const loadConversations = async () => {
      conversations = (await get("/admin/chat/conversations")).conversations;
      renderList();
    };

    const openConversation = async (id) => {
      const data = await get(`/admin/chat/conversations/${id}`);
      current = data.conversation;
      messages = data.messages;

      // Move the provider selector first, or setting the model would fail
      // whenever the open conversation belongs to a different provider than
      // the one currently selected.
      syncProviderToModel(current.model);
      el("#c-provider").dispatchEvent(new Event("change"));
      el("#c-model").value = current.model || meta.defaultModel;
      el("#c-effort").value = current.reasoningEffort;
      el("#c-auth").value = current.pinnedCredentialId ?? "";
      renderCaps();
      renderList();
      renderThread();
    };

    const currentCaps = () => {
      const model = el("#c-model").value.trim();
      const entry = meta?.models.find((m) => m.id === model);
      return entry?.capabilities ?? { reasoning: false };
    };

    const ensureConversation = async () => {
      if (current) return current;
      const body = {
        model: el("#c-model").value,
        reasoningEffort: currentCaps().reasoning ? el("#c-effort").value : undefined,
        pinnedCredentialId: el("#c-auth").value ? Number(el("#c-auth").value) : null,
      };
      current = (await post("/admin/chat/conversations", body)).conversation;
      messages = [];
      await loadConversations();
      renderList();
      return current;
    };

    /* ---------------------------------------------------- attachments */

    /*
     * Images staged for the next turn. Held here rather than on the textarea
     * so a drop, a paste and the file picker all funnel through one path and
     * the previews stay in sync with what will actually be sent.
     */
    let pending = [];

    const MAX_FILES = 8;
    const MAX_BYTES = 8 * 1024 * 1024;
    const OK_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"];

    const readAsDataUrl = (file) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.readAsDataURL(file);
      });

    const renderAttachments = () => {
      const box = el("#c-attachments");
      box.hidden = pending.length === 0;
      box.innerHTML = pending
        .map(
          (a, i) => `
          <div class="chat-attachment" title="${esc(a.name)}">
            <img src="${a.dataUrl}" alt="${esc(a.name)}">
            <button class="chat-attachment-x" data-i="${i}" aria-label="Remove ${esc(a.name)}">
              ${icon("close", 12)}
            </button>
          </div>`,
        )
        .join("");

      box.querySelectorAll(".chat-attachment-x").forEach((btn) => {
        btn.addEventListener("click", () => {
          pending.splice(Number(btn.dataset.i), 1);
          renderAttachments();
        });
      });
    };

    /** Stage files from any source, reporting anything rejected. */
    const addFiles = async (files) => {
      const list = [...files].filter((f) => f && f.size >= 0);
      if (!list.length) return;

      for (const file of list) {
        if (pending.length >= MAX_FILES) {
          toast(`Up to ${MAX_FILES} images per message.`, "bad");
          break;
        }
        // Some sources hand over an empty type; fall back to the extension so
        // a pasted screenshot is not rejected for lacking metadata.
        const type = (file.type || "").toLowerCase();
        if (type && !OK_TYPES.includes(type)) {
          toast(`${file.name || "That file"} is not a supported image.`, "bad");
          continue;
        }
        if (file.size > MAX_BYTES) {
          toast(
            `${file.name || "Image"} is ${(file.size / 1048576).toFixed(1)} MB — limit is ${MAX_BYTES / 1048576} MB.`,
            "bad",
          );
          continue;
        }
        try {
          const dataUrl = await readAsDataUrl(file);
          if (!dataUrl.startsWith("data:image/")) {
            toast(`${file.name || "That file"} is not an image.`, "bad");
            continue;
          }
          pending.push({
            name: file.name || "pasted-image.png",
            mimeType: type || dataUrl.slice(5, dataUrl.indexOf(";")),
            dataUrl,
          });
        } catch (err) {
          toast(err.message, "bad");
        }
      }
      renderAttachments();
      el("#c-input").focus();
    };

    el("#c-attach").addEventListener("click", () => el("#c-file").click());
    el("#c-file").addEventListener("change", (e) => {
      void addFiles(e.target.files ?? []);
      // Reset so selecting the same file twice in a row still fires `change`.
      e.target.value = "";
    });

    /*
     * Drag and drop. `dragover` must be cancelled or the browser navigates to
     * the dropped file instead of handing it over, which loses the whole
     * conversation.
     */
    const zone = el("#c-dropzone");
    let dragDepth = 0;

    const setDragging = (on) => zone.classList.toggle("dragging", on);

    zone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      // Nested children each fire dragenter/dragleave, so count depth rather
      // than toggling, or the hint flickers as the pointer crosses the
      // textarea.
      dragDepth += 1;
      setDragging(true);
    });
    zone.addEventListener("dragover", (e) => e.preventDefault());
    zone.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    });
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      setDragging(false);
      void addFiles(e.dataTransfer?.files ?? []);
    });

    /*
     * Paste. This is the one that matters most in practice: the common case is
     * a screenshot on the clipboard, which has no file to drag.
     */
    el("#c-input").addEventListener("paste", (e) => {
      const items = [...(e.clipboardData?.items ?? [])];
      const images = items.filter((i) => i.kind === "file" && i.type.startsWith("image/"));
      if (!images.length) return;
      // Only cancel the paste when there is actually an image, so pasting text
      // behaves exactly as before.
      e.preventDefault();
      void addFiles(images.map((i) => i.getAsFile()).filter(Boolean));
    });

    /* ----------------------------------------------------------- send */

    const setSending = (on) => {
      streaming = on;
      el("#c-send").disabled = on;
      el("#c-input").disabled = on;
      el("#c-send").innerHTML = on ? icon("pause", 17) : icon("chevron", 17);
    };

    const send = async () => {
      const input = el("#c-input");
      const content = input.value.trim();
      // An image with no caption is a valid turn — "what is this?" is implied.
      if ((!content && pending.length === 0) || streaming) return;

      // A provider with no known models shows a free-text box, which starts
      // empty. Sending that forwarded an empty model id upstream and came back
      // as a bare "Method Not Allowed".
      if (!el("#c-model").value.trim()) {
        toast("Enter a model id first — this provider has no model list yet.", "bad");
        el("#c-model").focus();
        return;
      }

      await ensureConversation();

      // Take the staged images now and clear the composer, so a second send
      // cannot re-attach what is already in flight.
      const attachments = pending;
      pending = [];
      renderAttachments();
      input.value = "";
      input.style.height = "auto";

      messages.push({ role: "user", content, attachments });
      messages.push({ role: "assistant", content: "", pending: true });
      renderThread();
      setSending(true);
      el("#c-foot").textContent = "Routing…";

      const assistant = messages[messages.length - 1];
      abort = new AbortController();

      try {
        const res = await fetch(`/admin/chat/conversations/${current.id}/send`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${state.key}`,
            accept: "text/event-stream",
          },
          body: JSON.stringify({ content, attachments }),
          signal: abort.signal,
        });

        if (!res.ok || !res.body) throw new Error(`Request failed (HTTP ${res.status})`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

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

            if (name === "start") {
              assistant.credentialName = payload.credentialName;
              assistant.model = payload.model;
              el("#c-foot").textContent =
                `Served by ${payload.credentialName} · ${payload.model}${payload.attempts > 1 ? ` after ${payload.attempts} attempts` : ""}`;
            } else if (name === "delta") {
              assistant.content += payload.text;
              renderThread();
            } else if (name === "reasoning") {
              el("#c-foot").textContent = "Thinking…";
            } else if (name === "done") {
              assistant.pending = false;
              assistant.tokens = payload.tokens;
              assistant.latencyMs = payload.latencyMs;
              el("#c-foot").textContent =
                `${payload.credentialName} · ${compact(payload.tokens)} tokens · ${payload.latencyMs}ms`;
              renderThread();
            } else if (name === "error") {
              assistant.pending = false;
              assistant.error = payload.message;
              el("#c-foot").textContent = "";
              renderThread();
            }
          }
        }
      } catch (err) {
        assistant.pending = false;
        if (err.name !== "AbortError") assistant.error = err.message;
        renderThread();
      } finally {
        setSending(false);
        abort = null;
        await loadConversations();
        // Restore keyboard flow after the streamed request finishes. The input
        // was disabled during send, and focus otherwise remains on the button.
        requestAnimationFrame(() => el("#c-input")?.focus());
      }
    };

    /* --------------------------------------------------------- events */

    el("#c-send").addEventListener("click", () => {
      if (streaming) abort?.abort();
      else send();
    });

    el("#c-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // Grow the composer with its content, up to a sane cap.
    el("#c-input").addEventListener("input", (e) => {
      e.target.style.height = "auto";
      e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
    });

    // Delegated for the same reason as above: the control is swapped between
    // <select> and <input> whenever the provider changes.
    host.addEventListener("change", async (e) => {
      if (e.target.id !== "c-model" || !current) return;
      await post(`/admin/chat/conversations/${current.id}`, { model: e.target.value });
    });

    el("#c-effort").addEventListener("change", async () => {
      if (current) await post(`/admin/chat/conversations/${current.id}`, { reasoningEffort: el("#c-effort").value });
    });

    el("#c-auth").addEventListener("change", async () => {
      const pinned = el("#c-auth").value ? Number(el("#c-auth").value) : null;
      if (current) await post(`/admin/chat/conversations/${current.id}`, { pinnedCredentialId: pinned });
    });

    el("#c-new").addEventListener("click", () => {
      current = null;
      messages = [];
      renderList();
      renderThread();
      el("#c-foot").textContent = "";
      el("#c-input").focus();
    });

    host.addEventListener("click", async (e) => {
      const delBtn = e.target.closest("[data-delconv]");
      if (delBtn) {
        e.stopPropagation();
        const id = Number(delBtn.dataset.delconv);
        const ok = await confirmDialog("Delete conversation", "This removes it and its messages permanently.", "Delete");
        if (!ok) return;
        await del(`/admin/chat/conversations/${id}`);
        if (current?.id === id) {
          current = null;
          messages = [];
          renderThread();
        }
        await loadConversations();
        return;
      }

      const item = e.target.closest("[data-conv]");
      if (item) return void openConversation(Number(item.dataset.conv));

      const copyBtn = e.target.closest("[data-copycode]");
      if (copyBtn) {
        navigator.clipboard.writeText(copyBtn.dataset.copycode).then(
          () => toast("Code copied"),
          () => toast("Could not copy", "bad"),
        );
      }
    });

    (async () => {
      try {
        await loadMeta();
        await loadConversations();
        renderThread();
        el("#c-input").focus();
      } catch (err) {
        toast(err.message, "bad");
      }
    })();

    return { destroy: () => abort?.abort() };
  },
};
