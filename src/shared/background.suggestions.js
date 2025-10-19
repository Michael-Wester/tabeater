(function () {
  const root = typeof globalThis !== "undefined" ? globalThis : this;

  const KEYS = {
    HISTORY: "pc.history",
    SETTINGS: "pc.settings",
    STATS: "pc.stats",
  };

  const DEFAULTS = {
    enableSuggestions: true,
    enableInactiveSuggestion: true,
    inactiveThresholdMinutes: 60,
    suggestMinOpenTabsPerDomain: 1,
    decayDays: 14,
    maxHistory: 200,
    trackHistory: true,
    trackStats: true,
    theme: "auto",
    showTabsEatenInHeader: true,
  };

  const now = () => Date.now();
  const domainFromUrl = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return null;
    }
  };
  const getStore = (k) =>
    new Promise((res) => chrome.storage.local.get(k, res));
  const setStore = (o) =>
    new Promise((res) => chrome.storage.local.set(o, res));

  async function getSettings() {
    const got = await getStore([KEYS.SETTINGS]);
    return { ...DEFAULTS, ...(got[KEYS.SETTINGS] || {}) };
  }
  async function updateSettings(patch) {
    const cur = await getSettings();
    const next = { ...cur, ...(patch || {}) };
    await setStore({ [KEYS.SETTINGS]: next });
  }

  async function pcRecordClosedTabs(urlsOrDomains) {
    const got = await getStore([KEYS.HISTORY, KEYS.SETTINGS]);
    const cfg = { ...DEFAULTS, ...(got[KEYS.SETTINGS] || {}) };
    if (!cfg.trackHistory) return;

    const hist = cfg.trackHistory ? got[KEYS.HISTORY] || [] : [];

    const byDomain = new Map(hist.map((x) => [x.domain, x]));
    const at = now();
    for (const item of urlsOrDomains) {
      const d = item.includes(".") ? item : domainFromUrl(item);
      const domain = (d || item || "").toLowerCase();
      if (!domain) continue;
      let row = byDomain.get(domain);
      if (!row) {
        row = { domain, count: 0, lastClosedAt: 0 };
        byDomain.set(domain, row);
      }
      row.count += 1;
      row.lastClosedAt = at;
    }
    const updated = Array.from(byDomain.values())
      .sort((a, b) => b.lastClosedAt - a.lastClosedAt)
      .slice(0, cfg.maxHistory);
    await setStore({ [KEYS.HISTORY]: updated });
  }

  async function pcGetSuggestions() {
    const got = await getStore([KEYS.HISTORY, KEYS.SETTINGS]);
    const cfg = { ...DEFAULTS, ...(got[KEYS.SETTINGS] || {}) };
    if (!cfg.enableSuggestions) return [];

    const hist = cfg.trackHistory ? got[KEYS.HISTORY] || [] : [];
    const decayMs = cfg.decayDays * 86400000;
    const nowTs = now();

    const tabs = await new Promise((res) => chrome.tabs.query({}, res));
    const openByDomain = new Map();
    for (const t of tabs) {
      if (t.incognito) continue;
      const d = domainFromUrl(t.url);
      if (!d) continue;
      openByDomain.set(d, (openByDomain.get(d) || 0) + 1);
    }

    const thresholdMinutes = Math.max(
      1,
      Number(cfg.inactiveThresholdMinutes) || 30
    );
    const thresholdMs = thresholdMinutes * 60000;

    let inactiveCount = 0;
    if (cfg.enableInactiveSuggestion) {
      const inactiveTabs = tabs.filter((t) => {
        if (t.incognito) return false;
        if (t.pinned || t.audible) return false;
        if (t.active) return false;
        const last = t.lastAccessed || 0;
        if (last) return nowTs - last >= thresholdMs;
        return t.discarded === true;
      });
      inactiveCount = inactiveTabs.length;
    }

    const scored = [];
    for (const [domain, openCount] of openByDomain) {
      if (openCount < cfg.suggestMinOpenTabsPerDomain) continue;
      const h = hist.find((x) => x.domain === domain);
      const recencyBoost = h
        ? Math.exp(-(nowTs - h.lastClosedAt) / decayMs)
        : 0.2;
      const freq = h ? h.count : 1;
      const score = openCount * (1 + freq * 0.5) * (0.5 + recencyBoost);
      scored.push({
        domain,
        openCount,
        freq,
        lastClosedAt: h?.lastClosedAt || 0,
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 10).map((item) => ({
      kind: "domain",
      domain: item.domain,
      openCount: item.openCount,
      freq: item.freq,
      lastClosedAt: item.lastClosedAt,
    }));

    const suggestions = [];
    if (inactiveCount) {
      suggestions.push({
        kind: "inactive",
        inactiveCount,
      });
    }
    suggestions.push(...top);
    return suggestions;
  }

  async function getStats() {
    const got = await getStore([KEYS.STATS]);
    const s = got[KEYS.STATS] || {
      totalTabsEaten: 0,
      byDomain: [],
      startedAt: now(),
    };
    s.byDomain.sort((a, b) => b.count - a.count);
    return s;
  }
  async function resetStats() {
    await setStore({
      [KEYS.STATS]: { totalTabsEaten: 0, byDomain: [], startedAt: now() },
    });
  }
  async function pcStatsEat({ count = 0, domains = [] } = {}) {
    if (!count) return;
    const got = await getStore([KEYS.STATS, KEYS.SETTINGS]);
    const cfg = { ...DEFAULTS, ...(got[KEYS.SETTINGS] || {}) };
    if (!cfg.trackStats) return;

    const s = got[KEYS.STATS] || {
      totalTabsEaten: 0,
      byDomain: [],
      startedAt: now(),
    };
    s.totalTabsEaten += count;
    const map = new Map(s.byDomain.map((x) => [x.domain, x]));
    for (const d of domains) {
      const key = (d || "").toLowerCase();
      if (!key) continue;
      const row = map.get(key) || { domain: key, count: 0 };
      row.count += count;
      map.set(key, row);
    }
    s.byDomain = Array.from(map.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 100);
    await setStore({ [KEYS.STATS]: s });
  }

  // Expose hooks to background.js / service worker global scope.
  root.pcRecordClosedTabs = pcRecordClosedTabs;
  root.pcStatsEat = pcStatsEat;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (!msg || !msg.type) return;

      if (msg.type === "pc:getSettings") {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === "pc:updateSettings") {
        await updateSettings(msg.payload || {});
        sendResponse({ ok: true });
      } else if (msg.type === "pc:getSuggestions") {
        sendResponse({ ok: true, suggestions: await pcGetSuggestions() });
      } else if (msg.type === "pc:getStats") {
        sendResponse({ ok: true, stats: await getStats() });
      } else if (msg.type === "pc:resetStats") {
        await resetStats();
        sendResponse({ ok: true });
      }
    })();
    return true;
  });
})();
