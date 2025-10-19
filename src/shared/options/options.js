// Options: theme, popup toggles, tracking controls, and stats display.

(() => {
  const KEY = "pc.settings";
  const DEFAULTS = {
    enableSuggestions: true,
    enableInactiveSuggestion: true,
    inactiveThresholdMinutes: 30,
    suggestMinOpenTabsPerDomain: 3,
    decayDays: 14,
    maxHistory: 200,
    trackHistory: true,
    trackStats: true,
    theme: "auto",
    showTabsEatenInHeader: true,
  };

  const $ = (id) => document.getElementById(id);
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, r));
  const set = (o) => new Promise((r) => chrome.storage.local.set(o, r));
  const msg = (type, payload) =>
    new Promise((res) =>
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, res)
    );

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme || "auto");
  }

  async function readSettings() {
    const raw = await get(KEY);
    return { ...DEFAULTS, ...(raw[KEY] || {}) };
  }
  async function writeSettings(patch) {
    const cur = await readSettings();
    const next = { ...cur, ...(patch || {}) };
    await set({ [KEY]: next });
    applyTheme(next.theme);
    return next;
  }

  function bindSave(id, map, after) {
    const el = $(id);
    if (!el) return;
    const handler = async () => {
      const next = await writeSettings(map(el));
      if (typeof after === "function") after(next);
    };
    el.addEventListener("change", handler);
    el.addEventListener("input", handler);
  }

  async function renderStats() {
    const settings = await readSettings();
    const resetBtn = $("stats-reset");
    const totalEl = $("stats-total");
    const listEl = $("stats-domains");
    const noteEl = $("stats-note");

    if (!totalEl || !listEl || !noteEl) return;

    if (!settings.trackStats) {
      totalEl.textContent = "Off";
      listEl.innerHTML = "";
      noteEl.textContent = "Stats tracking is disabled.";
      if (resetBtn) resetBtn.disabled = true;
      return;
    }

    if (resetBtn) resetBtn.disabled = false;

    const { stats } = (await msg("pc:getStats")) || {};
    const total = stats?.totalTabsEaten ?? 0;
    const top = stats?.byDomain ?? [];

    totalEl.textContent = total;

    if (!top.length) {
      listEl.innerHTML = "";
      noteEl.textContent = "No history yet. Close a few tabs to build stats.";
      if (!settings.trackHistory) {
        noteEl.textContent +=
          " Website history tracking is disabled, so recommendations use current tabs only.";
      }
      return;
    }

    const items = top.slice(0, 5).map(
      (row) =>
        `<li><span>${row.domain}</span><span>${row.count}</span></li>`
    );
    listEl.innerHTML = items.join("");
    noteEl.textContent = "Top domains you've closed recently.";
    if (!settings.trackHistory) {
      noteEl.textContent +=
        " Website history tracking is disabled, so recommendations use current tabs only.";
    }
  }

  async function init() {
    const s = await readSettings();
    applyTheme(s.theme);

    const withValue = (id, setter) => {
      const el = $(id);
      if (!el) return;
      setter(el);
    };

    withValue("theme", (el) => (el.value = s.theme));
    withValue(
      "min-open",
      (el) => (el.value = s.suggestMinOpenTabsPerDomain)
    );
    withValue(
      "show-tabs-eaten",
      (el) => (el.checked = !!s.showTabsEatenInHeader)
    );
    withValue(
      "enable-suggestions",
      (el) => (el.checked = !!s.enableSuggestions)
    );
    withValue(
      "enable-inactive",
      (el) => (el.checked = !!s.enableInactiveSuggestion)
    );
    withValue(
      "inactive-threshold",
      (el) => (el.value = s.inactiveThresholdMinutes)
    );
    withValue("track-history", (el) => (el.checked = !!s.trackHistory));
    withValue("track-stats", (el) => (el.checked = !!s.trackStats));

    bindSave("theme", (el) => ({ theme: el.value }));
    bindSave("min-open", (el) => ({
      suggestMinOpenTabsPerDomain: Math.max(1, Number(el.value) || 1),
    }));
    bindSave("show-tabs-eaten", (el) => ({
      showTabsEatenInHeader: el.checked,
    }));
    bindSave("enable-suggestions", (el) => ({
      enableSuggestions: el.checked,
    }));
    bindSave("enable-inactive", (el) => ({
      enableInactiveSuggestion: el.checked,
    }));
    bindSave(
      "inactive-threshold",
      (el) => ({
        inactiveThresholdMinutes: Math.max(1, Number(el.value) || 1),
      }),
      () => renderStats()
    );
    bindSave(
      "track-history",
      (el) => ({ trackHistory: el.checked }),
      () => renderStats()
    );
    bindSave(
      "track-stats",
      (el) => ({ trackStats: el.checked }),
      () => renderStats()
    );

    $("back-to-popup")?.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(chrome.runtime.getURL("popup/popup.html"), "_blank");
    });

    $("stats-reset")?.addEventListener("click", async () => {
      const btn = $("stats-reset");
      if (btn) btn.disabled = true;
      await msg("pc:resetStats");
      await renderStats();
    });

    await renderStats();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
