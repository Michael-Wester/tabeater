// Popup: Suggestions, stats, and settings live side-by-side with quick actions.

(function () {
  const $ = (selector) => document.querySelector(selector);
  const byId = (id) => document.getElementById(id);
  const msg = (type, payload) =>
    new Promise((res) =>
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, res)
    );

  const STORAGE_KEY = "pc.settings";
  const DEFAULTS = {
    enableSuggestions: true,
    enableInactiveSuggestion: true,
    inactiveThresholdMinutes: 30,
    suggestMinOpenTabsPerDomain: 3,
    decayDays: 14,
    maxHistory: 200,
    theme: "auto",
  };
  const FAVICON_SERVICE = "https://icons.duckduckgo.com/ip3/";

  function getFaviconUrl(domain) {
    if (!domain) return "";
    const trimmed = String(domain || "").trim().toLowerCase();
    if (!trimmed) return "";
    return `${FAVICON_SERVICE}${encodeURIComponent(trimmed)}.ico`;
  }

  let lastClosedTabs = [];
  let statusToken = 0;

  function setStatus(text, delay = 1400) {
    const el = $("#pc-status");
    if (!el) return;
    el.textContent = text || "";
    statusToken += 1;
    const token = statusToken;
    if (delay > 0) {
      setTimeout(() => {
        if (statusToken === token) el.textContent = "";
      }, delay);
    }
  }

  function updateUndoButton() {
    const btn = $("#pc-undo-close");
    if (!btn) return;
    btn.disabled = !lastClosedTabs.length;
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme || "auto");
  }

  async function readSettings() {
    const raw = await new Promise((r) =>
      chrome.storage.local.get(STORAGE_KEY, r)
    );
    return { ...DEFAULTS, ...(raw[STORAGE_KEY] || {}) };
  }

  async function writeSettings(patch) {
    const current = await readSettings();
    const next = { ...current, ...(patch || {}) };
    await new Promise((resolve) =>
      chrome.storage.local.set({ [STORAGE_KEY]: next }, resolve)
    );
    applyTheme(next.theme);
    return next;
  }

  function syncSettingsForm(settings) {
    const assign = (id, setter) => {
      const el = byId(id);
      if (el) setter(el);
    };

    assign("theme", (el) => (el.value = settings.theme));
    assign(
      "min-open",
      (el) => (el.value = settings.suggestMinOpenTabsPerDomain)
    );
    assign(
      "enable-suggestions",
      (el) => (el.checked = !!settings.enableSuggestions)
    );
    assign(
      "enable-inactive",
      (el) => (el.checked = !!settings.enableInactiveSuggestion)
    );
    assign(
      "inactive-threshold",
      (el) => (el.value = settings.inactiveThresholdMinutes)
    );
  }

  function bindSettingControl(id, map, after) {
    const el = byId(id);
    if (!el) return;
    const handler = async () => {
      const next = await writeSettings(map(el));
      if (typeof after === "function") after(next);
    };
    el.addEventListener("change", handler);
  }

  let suggestionsRequestToken = 0;
  function updateSuggestedVisibility(enabled) {
    const card = $("#pc-suggest-card");
    if (!card) return;
    const tags = $("#pc-suggest-tags");
    const empty = $("#pc-suggest-empty");
    const caption = $("#pc-suggest-caption");
    card.hidden = !enabled;
    card.style.display = enabled ? "" : "none";
    if (!enabled) {
      if (tags) tags.textContent = "";
      if (empty) {
        empty.textContent =
          "Recommendations disabled. Enable them in Settings to see ideas.";
      }
      if (caption) caption.textContent = "";
      return;
    }
    if (caption) {
      caption.textContent = "Tap a tag to close matching tabs.";
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = changes[STORAGE_KEY]?.newValue;
    if (!next) return;
    const settings = { ...DEFAULTS, ...next };
    applyTheme(settings.theme);
    updateSuggestedVisibility(!!settings.enableSuggestions);
    syncSettingsForm(settings);
    if (settings.enableSuggestions) {
      renderSuggestions();
    }
    renderSettingsStats();
  });

  async function initUI() {
    const settings = await readSettings();
    applyTheme(settings.theme);
    syncSettingsForm(settings);
    updateSuggestedVisibility(!!settings.enableSuggestions);
    if (settings.enableSuggestions) {
      $("#pc-suggest-caption").textContent = "Tap a tag to close matching tabs.";
    }
    updateUndoButton();
  }

  async function renderStatsPill() {
    const r = await msg("pc:getStats");
    const total = r?.stats?.totalTabsEaten || 0;
    $("#pc-count-pill").textContent = `${total} closed`;
  }

  async function renderSettingsStats() {
    const resetBtn = byId("stats-reset");
    const totalEl = byId("stats-total");
    const noteEl = byId("stats-note");
    if (!totalEl || !noteEl) return;

    if (resetBtn) resetBtn.disabled = false;
    const { stats } = (await msg("pc:getStats")) || {};
    const total = stats?.totalTabsEaten ?? 0;

    totalEl.textContent = total;
    noteEl.textContent = "Total tabs closed across all time.";
  }

  async function runClose(query) {
    if (!query) return;
    $("#pc-close").disabled = true;
    try {
      const out = await msg("pc:closeByKeyword", { query });
      if (out?.ok) {
        setStatus(`Closed ${out.closedCount}`);
        const closed = Array.isArray(out.closedTabs) ? out.closedTabs : [];
        if (closed.length) {
          lastClosedTabs = closed;
        } else if (out.closedCount > 0) {
          lastClosedTabs = [];
        }
        updateUndoButton();
      } else {
        setStatus("Failed");
      }
      await renderStatsPill();
      await renderSuggestions();
    } finally {
      $("#pc-close").disabled = false;
    }
  }

  async function runCloseInactive() {
    const out = await msg("pc:closeInactive");
    if (out?.ok && out.closedCount) {
      setStatus(`Closed ${out.closedCount} inactive`);
      const closed = Array.isArray(out.closedTabs) ? out.closedTabs : [];
      lastClosedTabs = closed.length ? closed : [];
      updateUndoButton();
    } else if (out?.ok) {
      setStatus("No inactive tabs", 1200);
    } else {
      setStatus("Failed");
    }
    await renderStatsPill();
    await renderSuggestions();
  }

  async function undoLastClose() {
    if (!lastClosedTabs.length) {
      setStatus("Nothing to undo", 1200);
      return;
    }
    const undoBtn = $("#pc-undo-close");
    if (undoBtn) undoBtn.disabled = true;

    let restored = 0;
    try {
      const out = await msg("pc:restoreTabs", { tabs: lastClosedTabs });
      if (!out?.ok) {
        setStatus("Undo failed");
        return;
      }
      restored = out.restoredCount || 0;
      if (restored) {
        setStatus(`Restored ${restored}`);
        lastClosedTabs = [];
      } else {
        setStatus("Nothing to restore", 1200);
      }
    } catch (err) {
      console.error("Undo failed", err);
      setStatus("Undo failed");
      return;
    } finally {
      updateUndoButton();
    }

    if (restored) {
      await renderStatsPill();
      await renderSuggestions();
    }
  }

  async function closeActiveDomain() {
    const tabs = await new Promise((res) =>
      chrome.tabs.query({ active: true, currentWindow: true }, res)
    );
    let domain = null;
    try {
      domain = new URL(tabs[0]?.url || "").hostname.replace(/^www\./, "");
    } catch {}
    if (!domain) {
      setStatus("No active domain", 1200);
      return;
    }
    await runClose(domain);
  }

  function renderSuggestionTag(item) {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "tag";

    const main = document.createElement("span");
    main.className = "tag-main";
    const label = document.createElement("span");
    label.className = "label";
    const count = document.createElement("span");
    count.className = "count";

    if (item.kind === "inactive") {
      tag.dataset.kind = "inactive";
      label.textContent = "Inactive";
      main.appendChild(label);
      count.textContent = String(item.inactiveCount ?? 0);
      tag.addEventListener("click", async () => {
        tag.disabled = true;
        try {
          await runCloseInactive();
        } finally {
          tag.disabled = false;
        }
      });
    } else {
      const domain = String(item.domain || "");
      tag.dataset.domain = domain;
      label.textContent = domain;
      const iconUrl = getFaviconUrl(domain);
      if (iconUrl) {
        const icon = document.createElement("img");
        icon.className = "favicon";
        icon.alt = "";
        icon.loading = "lazy";
        icon.decoding = "async";
        icon.src = iconUrl;
        icon.addEventListener("error", () => {
          icon.hidden = true;
        });
        main.appendChild(icon);
      }
      main.appendChild(label);
      const openCount = item.openCount ?? 0;
      count.textContent = `${openCount} open`;
      tag.addEventListener("click", async () => {
        tag.disabled = true;
        try {
          await runClose(item.domain);
        } finally {
          tag.disabled = false;
        }
      });
    }

    tag.append(main, count);
    return tag;
  }

  async function renderSuggestions() {
    const token = ++suggestionsRequestToken;
    const card = $("#pc-suggest-card");
    if (!card || card.hidden) return;

    const tagsWrap = $("#pc-suggest-tags");
    const empty = $("#pc-suggest-empty");
    const caption = $("#pc-suggest-caption");
    if (!tagsWrap || !empty || !caption) return;

    empty.textContent = "Loading...";
    caption.textContent = "";
    tagsWrap.textContent = "";

    const { ok, suggestions = [] } = await msg("pc:getSuggestions");
    if (token !== suggestionsRequestToken) return;
    if (!ok) {
      empty.textContent = "Couldn't load recommendations.";
      return;
    }
    if (!suggestions.length) {
      empty.textContent = "No recommendations right now.";
      return;
    }

    empty.textContent = "";
    caption.textContent = "Tap a tag to close matching tabs.";
    suggestions.forEach((item) => tagsWrap.appendChild(renderSuggestionTag(item)));
  }

  function setupSettingsBindings() {
    bindSettingControl("theme", (el) => ({ theme: el.value }));
    bindSettingControl(
      "min-open",
      (el) => ({
        suggestMinOpenTabsPerDomain: Math.max(1, Number(el.value) || 1),
      }),
      () => {
        renderSuggestions();
      }
    );
    bindSettingControl(
      "enable-suggestions",
      (el) => ({ enableSuggestions: el.checked }),
      (next) => {
        updateSuggestedVisibility(!!next.enableSuggestions);
        if (next.enableSuggestions) {
          renderSuggestions();
        }
      }
    );
    bindSettingControl(
      "enable-inactive",
      (el) => ({
        enableInactiveSuggestion: el.checked,
      }),
      () => {
        renderSuggestions();
      }
    );
    bindSettingControl(
      "inactive-threshold",
      (el) => ({
        inactiveThresholdMinutes: Math.max(1, Number(el.value) || 1),
      }),
      () => {
        renderSuggestions();
      }
    );

    const resetBtn = byId("stats-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", async () => {
        resetBtn.disabled = true;
        try {
          await msg("pc:resetStats");
        } finally {
          resetBtn.disabled = false;
        }
        await renderSettingsStats();
        await renderStatsPill();
      });
    }
  }

  function toggleSettingsPanel(show) {
    const actionsPanel = byId("pc-tab-actions");
    const settingsPanel = byId("pc-tab-settings");
    const toggleBtn = byId("pc-settings-toggle");
    if (!actionsPanel || !settingsPanel || !toggleBtn) return;

    const showSettings =
      typeof show === "boolean" ? show : settingsPanel.hidden;

    actionsPanel.hidden = showSettings;
    actionsPanel.setAttribute("aria-hidden", showSettings ? "true" : "false");

    settingsPanel.hidden = !showSettings;
    settingsPanel.setAttribute("aria-hidden", showSettings ? "false" : "true");

    toggleBtn.classList.toggle("active", showSettings);
    toggleBtn.setAttribute("aria-pressed", showSettings ? "true" : "false");

    if (showSettings) {
      renderSettingsStats();
    }
  }

  function wireUI() {
    $("#pc-close").addEventListener("click", () =>
      runClose($("#pc-query").value.trim())
    );
    $("#pc-query").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runClose($("#pc-query").value.trim());
      }
    });
    $("#pc-close-active-domain").addEventListener("click", closeActiveDomain);
    $("#pc-undo-close").addEventListener("click", undoLastClose);
    const closeInactiveBtn = byId("pc-close-inactive");
    if (closeInactiveBtn) {
      closeInactiveBtn.addEventListener("click", async () => {
        closeInactiveBtn.disabled = true;
        try {
          await runCloseInactive();
        } finally {
          closeInactiveBtn.disabled = false;
        }
      });
    }
    const settingsToggle = byId("pc-settings-toggle");
    if (settingsToggle) {
      settingsToggle.addEventListener("click", () => toggleSettingsPanel());
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await initUI();
    wireUI();
    setupSettingsBindings();
    toggleSettingsPanel(false);
    await renderStatsPill();
    await renderSuggestions();
    await renderSettingsStats();
  });
})();
