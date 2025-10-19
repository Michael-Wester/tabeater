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
    suggestMinOpenTabsPerDomain: 3,
    decayDays: 14,
    maxHistory: 200,
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

  // Live reaction to option changes (theme/tabs-eaten visibility) or popup toggle (enableSuggestions)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = changes[STORAGE_KEY]?.newValue;
    if (!next) return;
    const s = { ...DEFAULTS, ...next };
    applyTheme(s.theme);
    $("#pc-count-pill").style.display = s.showTabsEatenInHeader ? "" : "none";
    $("#pc-toggle-recommended").checked = !!s.enableSuggestions;
    $("#pc-suggest-card").hidden = !s.enableSuggestions;
    if (s.enableSuggestions) renderSuggestions();
  });

  async function initUI() {
    const s = await readSettings();
    applyTheme(s.theme);
    $("#pc-count-pill").style.display = s.showTabsEatenInHeader ? "" : "none";
    $("#pc-toggle-recommended").checked = !!s.enableSuggestions;
    $("#pc-suggest-card").hidden = !s.enableSuggestions;
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

  function renderSuggestionRow(s) {
    const row = document.createElement("div");
    row.className = "sugg-row";
    row.innerHTML = `
      <input type="checkbox" class="sugg-check" data-domain="${s.domain}">
      <div style="font-weight:600">${s.domain}</div>
      <div class="spacer"></div>
      <span class="small muted">${s.openCount} open</span>
      <button class="btn small" data-domain="${s.domain}">Close</button>
    `;
    row.querySelector("button").addEventListener("click", async (e) => {
      const d = e.currentTarget.getAttribute("data-domain");
      await runClose(d);
    });
    return row;
  }

  async function renderSuggestions() {
    if ($("#pc-suggest-card").hidden) return;
    const list = $("#pc-suggest-list");
    const btn = $("#pc-suggest-close");
    const hint = $("#pc-suggest-hint");
    list.textContent = "Loading…";
    const { ok, suggestions = [] } = await msg("pc:getSuggestions");
    list.innerHTML = "";
    if (!ok) {
      list.textContent = "Error";
      btn.disabled = true;
      hint.textContent = "";
      return;
    }
    if (!suggestions.length) {
      list.textContent = "No suggestions";
      btn.disabled = true;
      hint.textContent = "";
      return;
    }
    suggestions.forEach((s) => list.appendChild(renderSuggestionRow(s)));
    const update = () => {
      btn.disabled = list.querySelectorAll(".sugg-check:checked").length === 0;
      hint.textContent = "";
    };
    list.addEventListener("change", update, { once: true });
    update();
  }

  async function closeSelectedSuggestions() {
    const list = $("#pc-suggest-list");
    const checks = Array.from(list.querySelectorAll(".sugg-check:checked"));
    if (!checks.length) return;
    $("#pc-suggest-close").disabled = true;
    try {
      for (const c of checks) {
        await runClose(c.getAttribute("data-domain"));
      }
    } finally {
      $("#pc-suggest-close").disabled = false;
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
    $("#pc-suggest-close").addEventListener("click", closeSelectedSuggestions);

    // Toggle Recommended (persist)
    $("#pc-toggle-recommended").addEventListener("change", async (e) => {
      const next = await writeSettings({
        enableSuggestions: !!e.target.checked,
      });
      $("#pc-suggest-card").hidden = !next.enableSuggestions;
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
