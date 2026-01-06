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
    enableInactiveSuggestion: true,
    inactiveThresholdMinutes: 30,
    suggestMinOpenTabsPerDomain: 3,
    decayDays: 14,
    maxHistory: 200,
    theme: "light",
  };

  function normalizeSettings(raw) {
    const settings = { ...DEFAULTS, ...(raw || {}) };
    delete settings.enableSuggestions;
    return settings;
  }

  let lastClosedTabs = [];
  let statusToken = 0;
  let lastStatsTotal = null;
  let lastOpenTabCount = null;
  let lastSuggestionsKey = null;
  let lastSuggestionsCount = null;
  const MAX_SUGGESTIONS = 12;

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
    document.documentElement.setAttribute("data-theme", theme || "light");
  }

  async function readSettings() {
    const raw = await new Promise((r) =>
      chrome.storage.local.get(STORAGE_KEY, r)
    );
    return normalizeSettings(raw[STORAGE_KEY]);
  }

  async function writeSettings(patch) {
    const current = await readSettings();
    const next = normalizeSettings({ ...current, ...(patch || {}) });
    await new Promise((resolve) =>
      chrome.storage.local.set({ [STORAGE_KEY]: next }, resolve)
    );
    applyTheme(next.theme);
    return next;
  }

  function syncThemeButtons(theme) {
    const buttons = document.querySelectorAll("[data-theme-value]");
    buttons.forEach((btn) => {
      const value = btn.dataset.themeValue || "light";
      const isActive = value === theme;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function syncSettingsForm(settings) {
    const assign = (id, setter) => {
      const el = byId(id);
      if (el) setter(el);
    };

    syncThemeButtons(settings.theme);
    assign(
      "min-open",
      (el) => (el.value = settings.suggestMinOpenTabsPerDomain)
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

  function bindThemeButtons() {
    const buttons = document.querySelectorAll("[data-theme-value]");
    buttons.forEach((btn) => {
      btn.addEventListener("click", async () => {
        const theme = btn.dataset.themeValue || "light";
        const next = await writeSettings({ theme });
        syncThemeButtons(next.theme);
      });
    });
  }

  let suggestionsRequestToken = 0;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = changes[STORAGE_KEY]?.newValue;
    if (!next) return;
    const settings = normalizeSettings(next);
    applyTheme(settings.theme);
    syncSettingsForm(settings);
    renderSuggestions();
  });

  async function initUI() {
    const settings = await readSettings();
    applyTheme(settings.theme);
    syncSettingsForm(settings);
    $("#pc-suggest-caption").textContent = "Tap to close tabs from site";
    updateUndoButton();
  }

  async function renderStatsPill() {
    const r = await msg("pc:getStats");
    const total = r?.stats?.totalTabsEaten || 0;
    if (total === lastStatsTotal) return;
    $("#pc-count-pill").textContent = `${total} closed`;
    lastStatsTotal = total;
  }

  async function renderOpenTabCount() {
    const el = byId("pc-open-count");
    if (!el) return;
    try {
      const tabs = await new Promise((res) => chrome.tabs.query({}, res));
      const total = Array.isArray(tabs)
        ? tabs.filter((t) => !t.incognito).length
        : 0;
      if (total !== lastOpenTabCount) {
        el.textContent = `${total} open`;
        lastOpenTabCount = total;
      }
    } catch (err) {
      console.error("Tab count load failed", err);
      el.textContent = "";
      lastOpenTabCount = null;
    }
  }

  async function renderSettingsStats() {
    await renderStatsPill();
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
      await renderOpenTabCount();
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
    await renderOpenTabCount();
    await renderSuggestions();
  }

  async function runCloseDuplicates() {
    const btn = byId("pc-close-duplicates");
    if (btn) btn.disabled = true;
    try {
      const out = await msg("pc:closeDuplicates");
      if (out?.ok) {
        const count = out.closedCount || 0;
        setStatus(count ? `Closed ${count} duplicates` : "No duplicates", 1400);
        const closed = Array.isArray(out.closedTabs) ? out.closedTabs : [];
        lastClosedTabs = closed.length ? closed : count ? [] : lastClosedTabs;
        updateUndoButton();
      } else {
        setStatus("Failed");
      }
    } finally {
      if (btn) btn.disabled = false;
    }
    await renderStatsPill();
    await renderOpenTabCount();
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
      await renderOpenTabCount();
      await renderSuggestions();
    }
  }

  function renderSuggestionChip(item) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";

    const main = document.createElement("span");
    main.className = "chip-main";
    const label = document.createElement("span");
    label.className = "label";
    const count = document.createElement("span");
    count.className = "count";

    if (item.kind === "inactive") {
      chip.dataset.kind = "inactive";
      const icon = document.createElement("img");
      icon.className = "favicon";
      icon.alt = "";
      icon.loading = "lazy";
      icon.decoding = "async";
      icon.src = "../icons/icon16-inactive.png";
      icon.addEventListener("error", () => {
        icon.hidden = true;
      });
      main.appendChild(icon);
      label.textContent = "Inactive";
      main.appendChild(label);
      count.textContent = String(item.inactiveCount ?? 0);
      chip.addEventListener("click", async () => {
        chip.disabled = true;
        try {
          await runCloseInactive();
        } finally {
          chip.disabled = false;
        }
      });
    } else {
      const domain = String(item.domain || "");
      chip.dataset.domain = domain;
      label.textContent = domain;
      const iconUrl =
        typeof item.favIconUrl === "string" ? item.favIconUrl.trim() : "";
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
      chip.addEventListener("click", async () => {
        chip.disabled = true;
        try {
          await runClose(item.domain);
        } finally {
          chip.disabled = false;
        }
      });
    }

    chip.append(main, count);
    return chip;
  }

  async function renderSuggestions() {
    const token = ++suggestionsRequestToken;
    const card = $("#pc-suggest-card");
    if (!card || card.getAttribute("aria-hidden") === "true") return;

    const chipsWrap = $("#pc-suggest-chips");
    const empty = $("#pc-suggest-empty");
    const caption = $("#pc-suggest-caption");
    const more = $("#pc-suggest-more");
    if (!chipsWrap || !empty || !caption || !more) return;

    const shouldShowLoading = lastSuggestionsKey === null;
    if (shouldShowLoading) {
      empty.textContent = "Loading suggestion chips...";
      caption.textContent = "";
      chipsWrap.textContent = "";
    }

    const { ok, suggestions = [] } = await msg("pc:getSuggestions");
    if (token !== suggestionsRequestToken) return;
    const key = ok ? JSON.stringify(suggestions) : "error";
    const count = Array.isArray(suggestions) ? suggestions.length : 0;
    if (key === lastSuggestionsKey && count === lastSuggestionsCount && !shouldShowLoading) {
      return;
    }
    lastSuggestionsKey = key;
    lastSuggestionsCount = count;

    chipsWrap.textContent = "";
    more.textContent = "";
    if (!ok) {
      empty.textContent = "Couldn't load suggestions";
      caption.textContent = "";
      return;
    }
    if (!suggestions.length) {
      empty.textContent = "No suggestions right now";
      caption.textContent = "";
      return;
    }

    empty.textContent = "";
    caption.textContent = "Tap to close tabs from site";
    const limited = suggestions.slice(0, MAX_SUGGESTIONS);
    limited.forEach((item) =>
      chipsWrap.appendChild(renderSuggestionChip(item))
    );
    if (suggestions.length > MAX_SUGGESTIONS) {
      more.textContent = `${suggestions.length - MAX_SUGGESTIONS} more not shown`;
    }
  }

  async function sortTabsByOpenCount() {
    const btn = byId("pc-sort-tabs-quick");
    if (btn) btn.disabled = true;
    try {
      const out = await msg("pc:sortTabsByOpenCount");
      if (!out?.ok) {
        setStatus("Sort failed", 1200);
        return;
      }
      const moved = out.sortedCount || 0;
      setStatus(moved ? `Reordered ${moved} tabs` : "Nothing to sort", 1200);
    } catch (err) {
      console.error("Sort tabs failed", err);
      setStatus("Sort failed", 1200);
    } finally {
      if (btn) btn.disabled = false;
    }
    await renderSuggestions();
  }

  function setupSettingsBindings() {
    bindThemeButtons();
    bindSettingControl(
      "min-open",
      (el) => ({
        suggestMinOpenTabsPerDomain: Math.max(1, Number(el.value) || 1),
      }),
      () => {
        renderSuggestions();
      }
    );
    bindSettingControl("inactive-threshold", (el) => ({
      inactiveThresholdMinutes: Math.max(1, Number(el.value) || 1),
    }));
  }

  function toggleSettingsPanel(show) {
    const actionsPanel = byId("pc-tab-actions");
    const settingsPanel = byId("pc-tab-settings");
    const toggleBtn = byId("pc-settings-toggle");
    if (!actionsPanel || !settingsPanel || !toggleBtn) return;

    const settingsActive = settingsPanel.classList.contains("active");
    const showSettings = typeof show === "boolean" ? show : !settingsActive;

    actionsPanel.classList.toggle("active", !showSettings);
    actionsPanel.setAttribute("aria-hidden", showSettings ? "true" : "false");

    settingsPanel.classList.toggle("active", showSettings);
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
    $("#pc-undo-close").addEventListener("click", undoLastClose);
    const sortTabsQuick = byId("pc-sort-tabs-quick");
    if (sortTabsQuick) {
      sortTabsQuick.addEventListener("click", async () => {
        sortTabsQuick.disabled = true;
        try {
          await sortTabsByOpenCount();
        } finally {
          sortTabsQuick.disabled = false;
        }
      });
    }
    const closeDuplicates = byId("pc-close-duplicates");
    if (closeDuplicates) {
      closeDuplicates.addEventListener("click", () => runCloseDuplicates());
    }
    const settingsToggle = byId("pc-settings-toggle");
    if (settingsToggle) {
      settingsToggle.addEventListener("click", () => toggleSettingsPanel());
    }
    const quickToggle = byId("pc-toggle-quick");
    const quickBody = byId("pc-quick-body");
    if (quickToggle && quickBody) {
      quickToggle.addEventListener("click", () => {
        const hidden = quickBody.hidden === true;
        quickBody.hidden = !hidden;
        quickToggle.textContent = hidden ? "Hide" : "Show";
        quickToggle.setAttribute("aria-pressed", hidden ? "true" : "false");
      });
    }

    // Removed sort button from suggestion chips section; quick action remains.
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await initUI();
    wireUI();
    setupSettingsBindings();
    toggleSettingsPanel(false);
    await renderStatsPill();
    await renderOpenTabCount();
    await renderSuggestions();
    const initial = await readSettings();
    const tabsApi = chrome?.tabs;
    if (tabsApi?.onCreated) tabsApi.onCreated.addListener(renderOpenTabCount);
    if (tabsApi?.onRemoved) tabsApi.onRemoved.addListener(renderOpenTabCount);
    if (tabsApi?.onReplaced) tabsApi.onReplaced.addListener(renderOpenTabCount);
  });
})();
