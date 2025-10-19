const root = typeof globalThis !== "undefined" ? globalThis : this;
const SETTINGS_KEY = "pc.settings";
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

// In MV3 service workers we must pull in helper script manually.
if (
  typeof root.pcRecordClosedTabs !== "function" &&
  typeof importScripts === "function"
) {
  try {
    importScripts("background.suggestions.js");
  } catch (err) {
    console.error("TabEater: unable to import suggestions helpers", err);
  }
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
function tabsQuery(q) {
  return new Promise((res) => chrome.tabs.query(q || {}, res));
}
function tabsRemove(ids) {
  return new Promise((res) => chrome.tabs.remove(ids, res));
}
function getSettings() {
  return new Promise((res) => {
    chrome.storage.local.get(SETTINGS_KEY, (raw) => {
      res({ ...DEFAULTS, ...(raw?.[SETTINGS_KEY] || {}) });
    });
  });
}

async function closeByKeyword(keyword) {
  if (!keyword || typeof keyword !== "string")
    return { closedCount: 0, closedDomains: [] };

  const kw = keyword.trim();
  const tabs = await tabsQuery({});
  const toClose = [];
  const closedDomains = new Set();

  const looksLikeDomain = /\./.test(kw);
  if (looksLikeDomain) {
    const wanted = kw.replace(/^www\./, "").toLowerCase();
    for (const t of tabs) {
      if (t.incognito) continue;
      const d = domainFromUrl(t.url);
      if (d === wanted) {
        toClose.push(t.id);
        if (d) closedDomains.add(d);
      }
    }
  } else {
    const rx = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    for (const t of tabs) {
      if (t.incognito) continue;
      const d = domainFromUrl(t.url);
      if ((t.title && rx.test(t.title)) || (t.url && rx.test(t.url))) {
        toClose.push(t.id);
        if (d) closedDomains.add(d);
      }
    }
  }

  if (toClose.length) {
    await tabsRemove(toClose);
    const recordClosedTabs = root.pcRecordClosedTabs;
    if (typeof recordClosedTabs === "function" && closedDomains.size) {
      try {
        await recordClosedTabs(Array.from(closedDomains));
      } catch {}
    }
    const statsEat = root.pcStatsEat;
    if (typeof statsEat === "function") {
      try {
        await statsEat({
          count: toClose.length,
          domains: Array.from(closedDomains),
        });
      } catch {}
    }
  }

  return {
    closedCount: toClose.length,
    closedDomains: Array.from(closedDomains),
  };
}

async function closeInactiveTabs() {
  const settings = await getSettings();
  const thresholdMinutes = Math.max(
    1,
    Number(settings.inactiveThresholdMinutes) || 30
  );
  const thresholdMs = thresholdMinutes * 60000;
  const nowTs = Date.now();

  const tabs = await tabsQuery({});
  const toClose = [];
  const closedDomains = new Set();

  for (const tab of tabs) {
    if (tab.incognito) continue;
    if (tab.pinned || tab.audible) continue;
    if (tab.active) continue;
    const last = tab.lastAccessed || 0;
    const isInactive = last
      ? nowTs - last >= thresholdMs
      : tab.discarded === true;
    if (!isInactive) continue;
    toClose.push(tab.id);
    const d = domainFromUrl(tab.url);
    if (d) closedDomains.add(d);
  }

  if (toClose.length) {
    await tabsRemove(toClose);
    const recordClosedTabs = root.pcRecordClosedTabs;
    if (typeof recordClosedTabs === "function" && closedDomains.size) {
      try {
        await recordClosedTabs(Array.from(closedDomains));
      } catch {}
    }
    const statsEat = root.pcStatsEat;
    if (typeof statsEat === "function") {
      try {
        await statsEat({
          count: toClose.length,
          domains: Array.from(closedDomains),
        });
      } catch {}
    }
  }

  return {
    closedCount: toClose.length,
    closedDomains: Array.from(closedDomains),
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "pc:closeByKeyword" && msg.query) {
    (async () => {
      sendResponse({ ok: true, ...(await closeByKeyword(msg.query)) });
    })();
    return true;
  }

  if (msg.type === "pc:closeInactive") {
    (async () => {
      sendResponse({ ok: true, ...(await closeInactiveTabs()) });
    })();
    return true;
  }

  return undefined;
});
