// Popup: Suggestions react to settings changes; theme + pill react to storage; no deprecated settings left.

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
  function updateSuggestedVisibility(enabled) {
    const card = $("#pc-suggest-card");
    if (!card) return;
    card.hidden = !enabled;
    card.style.display = enabled ? "" : "none";
    if (!enabled) {
      $("#pc-suggest-tags").innerHTML = "";
      $("#pc-suggest-empty").textContent =
        "Recommendations disabled. Enable them in Settings to see ideas.";
      $("#pc-suggest-caption").textContent = "";
      return;
    }
    $("#pc-suggest-caption").textContent = "Tap a tag to close matching tabs.";
  }

  // Live reaction to option changes (theme/tabs-eaten visibility/suggestions)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = changes[STORAGE_KEY]?.newValue;
    if (!next) return;
    const s = { ...DEFAULTS, ...next };
    applyTheme(s.theme);
    $("#pc-count-pill").style.display = s.showTabsEatenInHeader ? "" : "none";
    updateSuggestedVisibility(!!s.enableSuggestions);
    if (s.enableSuggestions) {
      renderSuggestions();
    }
  });

  async function initUI() {
    const s = await readSettings();
    applyTheme(s.theme);
    $("#pc-count-pill").style.display = s.showTabsEatenInHeader ? "" : "none";
    updateSuggestedVisibility(!!s.enableSuggestions);
    if (s.enableSuggestions) {
      $("#pc-suggest-caption").textContent = "Tap a tag to close matching tabs.";
    }
    updateUndoButton();
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
      if (closed.length) {
        lastClosedTabs = closed;
      } else {
        lastClosedTabs = [];
      }
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

    if (item.kind === "inactive") {
      tag.dataset.kind = "inactive";
      tag.innerHTML = `
        <span class="label">Inactive</span>
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
        <span class="label">${item.domain}</span>
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
    $("#pc-undo-close").addEventListener("click", undoLastClose);

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

