(function () {
  const root = typeof globalThis !== "undefined" ? globalThis : this;

  const KEYS = {
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
    showQuickActions: true,
    theme: "auto",
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

  async function pcGetSuggestions() {
    const got = await getStore([KEYS.SETTINGS]);
    const cfg = { ...DEFAULTS, ...(got[KEYS.SETTINGS] || {}) };
    if (!cfg.enableSuggestions) return [];

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
    const nowTs = now();

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

    const domains = Array.from(openByDomain.entries())
      .filter(([, openCount]) => openCount >= cfg.suggestMinOpenTabsPerDomain)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([domain, openCount]) => ({
        kind: "domain",
        domain,
        openCount,
      }));

    const suggestions = [];
    if (inactiveCount) {
      suggestions.push({
        kind: "inactive",
        inactiveCount,
      });
    }
    suggestions.push(...domains);
    return suggestions;
  }

  async function getStats() {
    const got = await getStore([KEYS.STATS]);
    return got[KEYS.STATS] || {
      totalTabsEaten: 0,
      startedAt: now(),
    };
  }
  async function resetStats() {
    await setStore({
      [KEYS.STATS]: { totalTabsEaten: 0, startedAt: now() },
    });
  }
  async function pcStatsEat({ count = 0 } = {}) {
    if (!count) return;
    const got = await getStore([KEYS.STATS]);

    const s =
      got[KEYS.STATS] || {
        totalTabsEaten: 0,
        startedAt: now(),
      };
    s.totalTabsEaten += count;
    await setStore({ [KEYS.STATS]: s });
  }

  // Expose hooks to background.js / service worker global scope.
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
