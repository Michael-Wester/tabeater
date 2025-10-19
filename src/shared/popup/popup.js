// Popup: Recommended toggle persists; theme + pill react to storage; no deprecated settings left.

(function () {
  const $ = (s) => document.querySelector(s);
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
    trackHistory: true,
    trackStats: true,
    theme: "auto",
    showTabsEatenInHeader: true,
  };

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
    const cur = await readSettings();
    const next = { ...cur, ...(patch || {}) };
    await new Promise((r) =>
      chrome.storage.local.set({ [STORAGE_KEY]: next }, r)
    );
    return next;
  }

  function updateSuggestedVisibility(enabled) {
    const card = $("#pc-suggest-card");
    card.hidden = !enabled;
    if (!enabled) {
      $("#pc-suggest-tags").innerHTML = "";
      $("#pc-suggest-empty").textContent = "Turn on recommended to see ideas.";
      $("#pc-suggest-caption").textContent = "";
    }
  }

  // Live reaction to option changes (theme/tabs-eaten visibility) or popup toggle (enableSuggestions)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = changes[STORAGE_KEY]?.newValue;
    if (!next) return;
    const s = { ...DEFAULTS, ...next };
    applyTheme(s.theme);
    $("#pc-count-pill").style.display = s.showTabsEatenInHeader ? "" : "none";
    $("#pc-toggle-recommended").checked = !!s.enableSuggestions;
    updateSuggestedVisibility(!!s.enableSuggestions);
    if (s.enableSuggestions) {
      renderSuggestions();
    }
  });

  async function initUI() {
    const s = await readSettings();
    applyTheme(s.theme);
    $("#pc-count-pill").style.display = s.showTabsEatenInHeader ? "" : "none";
    $("#pc-toggle-recommended").checked = !!s.enableSuggestions;
    updateSuggestedVisibility(!!s.enableSuggestions);
    if (s.enableSuggestions) {
      $("#pc-suggest-caption").textContent = "Tap a tag to close matching tabs.";
    }
  }

  // tabs-eaten pill (persistent via background stats)
  async function renderStatsPill() {
    const r = await msg("pc:getStats");
    const total = r?.stats?.totalTabsEaten || 0;
    $("#pc-count-pill").textContent = `${total} closed`;
  }

  async function runClose(query) {
    if (!query) return;
    $("#pc-close").disabled = true;
    try {
      const out = await msg("pc:closeByKeyword", { query });
      $("#pc-status").textContent = out?.ok
        ? `Closed ${out.closedCount}`
        : "Failed";
      setTimeout(() => ($("#pc-status").textContent = ""), 1400);
      await renderStatsPill();
      await renderSuggestions();
    } finally {
      $("#pc-close").disabled = false;
    }
  }

  async function runCloseInactive() {
    const out = await msg("pc:closeInactive");
    $("#pc-status").textContent =
      out?.ok && out.closedCount
        ? `Closed ${out.closedCount} inactive`
        : "No inactive tabs";
    setTimeout(() => ($("#pc-status").textContent = ""), 1400);
    await renderStatsPill();
    await renderSuggestions();
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
      $("#pc-status").textContent = "No active domain";
      setTimeout(() => ($("#pc-status").textContent = ""), 1200);
      return;
    }
    await runClose(domain);
  }

  function renderSuggestionTag(item) {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "tag";

    if (item.kind === "inactive") {
      tag.dataset.kind = "inactive";
      tag.innerHTML = `
        <span>Inactive</span>
        <span class="count">${item.inactiveCount}</span>
      `;
      tag.addEventListener("click", async () => {
        tag.disabled = true;
        try {
          await runCloseInactive();
        } finally {
          tag.disabled = false;
        }
      });
    } else {
      tag.dataset.domain = item.domain;
      tag.innerHTML = `
        <span>${item.domain}</span>
        <span class="count">${item.openCount} open</span>
      `;
      tag.addEventListener("click", async () => {
        tag.disabled = true;
        try {
          await runClose(item.domain);
        } finally {
          tag.disabled = false;
        }
      });
    }

    return tag;
  }

  async function renderSuggestions() {
    const card = $("#pc-suggest-card");
    if (card.hidden) return;

    const tagsWrap = $("#pc-suggest-tags");
    const empty = $("#pc-suggest-empty");
    const caption = $("#pc-suggest-caption");

    empty.textContent = "Loading...";
    caption.textContent = "";
    tagsWrap.innerHTML = "";

    const { ok, suggestions = [] } = await msg("pc:getSuggestions");
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

    // Toggle Recommended (persist)
    $("#pc-toggle-recommended").addEventListener("change", async (e) => {
      const next = await writeSettings({
        enableSuggestions: !!e.target.checked,
      });
      updateSuggestedVisibility(next.enableSuggestions);
      if (next.enableSuggestions) renderSuggestions();
    });

    // Open Options
    $("#pc-open-settings").addEventListener("click", () => {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else window.open(chrome.runtime.getURL("options/options.html"));
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await initUI();
    wireUI();
    await renderStatsPill();
    await renderSuggestions();
  });
})();
