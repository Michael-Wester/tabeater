// Options: only theme, min-open, showTabsEatenInHeader. Pruned deprecated settings.

(() => {
  const KEY = "pc.settings";
  const DEFAULTS = {
    enableSuggestions: true, // controlled in popup
    suggestMinOpenTabsPerDomain: 3,
    decayDays: 14,
    maxHistory: 200,
    theme: "auto",
    showTabsEatenInHeader: true,
  };

  const $ = (id) => document.getElementById(id);
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, r));
  const set = (o) => new Promise((r) => chrome.storage.local.set(o, r));

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

  function bindSave(id, map) {
    const el = $(id);
    if (!el) return;
    const handler = async () => {
      await writeSettings(map(el));
    };
    el.addEventListener("change", handler);
    el.addEventListener("input", handler);
  }

  async function init() {
    const s = await readSettings();
    applyTheme(s.theme);

    // set current values
    const minOpen = $("#min-open");
    if (minOpen) {
      minOpen.value = s.suggestMinOpenTabsPerDomain;
    }
    const theme = $("#theme");
    if (theme) {
      theme.value = s.theme;
    }
    const showTabs = $("#show-tabs-eaten");
    if (showTabs) {
      showTabs.checked = !!s.showTabsEatenInHeader;
    }

    // save bindings
    bindSave("min-open", (el) => ({
      suggestMinOpenTabsPerDomain: Math.max(1, Number(el.value) || 1),
    }));
    bindSave("theme", (el) => ({ theme: el.value }));
    bindSave("show-tabs-eaten", (el) => ({
      showTabsEatenInHeader: el.checked,
    }));

    // back to popup
    $("#back-to-popup")?.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(chrome.runtime.getURL("popup/popup.html"), "_blank");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
