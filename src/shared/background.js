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

const CONTEXT_MENU_IDS = {
  CLOSE_ACTIVE_DOMAIN: "pc.closeActiveDomain",
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
function tabsCreate(options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(options, (tab) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(tab);
    });
  });
}
function serializeTab(tab) {
  if (!tab) return null;
  const url = tab.url || tab.pendingUrl || "";
  if (!url) return null;
  const out = {
    url,
    windowId: typeof tab.windowId === "number" ? tab.windowId : undefined,
    index: typeof tab.index === "number" ? tab.index : undefined,
    active: !!tab.active,
    pinned: !!tab.pinned,
  };
  return out;
}
function setupContextMenus() {
  if (typeof chrome === "undefined") return;
  const menus = chrome.contextMenus;
  if (!menus || typeof menus.removeAll !== "function") return;
  menus.removeAll(() => {
    const removeErr = chrome.runtime.lastError;
    if (removeErr && removeErr.message) {
      console.warn("TabEater: removeAll context menus", removeErr);
    }
    menus.create(
      {
        id: CONTEXT_MENU_IDS.CLOSE_ACTIVE_DOMAIN,
        title: "Close active domain",
        contexts: ["page"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err && err.message)
          console.warn("TabEater: context menu create failed", err);
      }
    );
  });
}

async function closeActiveDomainFromContext(tab, info) {
  const url = tab?.url || info?.pageUrl || "";
  const domain = domainFromUrl(url);
  if (!domain) return;
  try {
    await closeByKeyword(domain);
  } catch (err) {
    console.error("TabEater: closeActiveDomain (context)", err);
  }
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
  const closedTabs = [];

  const looksLikeDomain = /\./.test(kw);
  if (looksLikeDomain) {
    const wanted = kw.replace(/^www\./, "").toLowerCase();
    for (const t of tabs) {
      if (t.incognito) continue;
      const d = domainFromUrl(t.url);
      if (d === wanted) {
        toClose.push(t.id);
        if (d) closedDomains.add(d);
        const snapshot = serializeTab(t);
        if (snapshot) closedTabs.push(snapshot);
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
        const snapshot = serializeTab(t);
        if (snapshot) closedTabs.push(snapshot);
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
    closedTabs,
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
  const closedTabs = [];

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
    const snapshot = serializeTab(tab);
    if (snapshot) closedTabs.push(snapshot);
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
    closedTabs,
  };
}

async function restoreTabs(tabs) {
  if (!Array.isArray(tabs) || !tabs.length) return { restoredCount: 0 };

  const cleaned = tabs
    .map((tab) => {
      if (!tab || typeof tab.url !== "string" || !tab.url) return null;
      return {
        url: tab.url,
        windowId: typeof tab.windowId === "number" ? tab.windowId : undefined,
        index: typeof tab.index === "number" ? tab.index : undefined,
        active: !!tab.active,
        pinned: !!tab.pinned,
      };
    })
    .filter(Boolean);

  if (!cleaned.length) return { restoredCount: 0 };

  cleaned.sort((a, b) => {
    const winA =
      typeof a.windowId === "number" ? a.windowId : Number.MAX_SAFE_INTEGER;
    const winB =
      typeof b.windowId === "number" ? b.windowId : Number.MAX_SAFE_INTEGER;
    if (winA !== winB) return winA - winB;
    const idxA =
      typeof a.index === "number" ? a.index : Number.MAX_SAFE_INTEGER;
    const idxB =
      typeof b.index === "number" ? b.index : Number.MAX_SAFE_INTEGER;
    return idxA - idxB;
  });

  const activatedWindows = new Set();
  let activatedFallback = false;
  let restored = 0;

  for (const tab of cleaned) {
    const opts = {
      url: tab.url,
      active: false,
    };
    if (typeof tab.windowId === "number") {
      opts.windowId = tab.windowId;
    }
    if (typeof tab.index === "number") {
      opts.index = Math.max(0, tab.index);
    }
    if (tab.pinned) {
      opts.pinned = true;
    }

    if (tab.active) {
      if (
        typeof tab.windowId === "number" &&
        !activatedWindows.has(tab.windowId)
      ) {
        opts.active = true;
        activatedWindows.add(tab.windowId);
      } else if (!activatedFallback) {
        opts.active = true;
        activatedFallback = true;
      }
    }

    try {
      await tabsCreate(opts);
      restored += 1;
    } catch (err) {
      if (opts.windowId !== undefined) {
        try {
          const fallback = {
            url: tab.url,
            active: opts.active,
          };
          if (tab.pinned) fallback.pinned = true;
          await tabsCreate(fallback);
          restored += 1;
          continue;
        } catch (fallbackErr) {
          console.warn("TabEater: fallback restore failed", fallbackErr);
        }
      } else {
        console.warn("TabEater: restore failed", err);
      }
    }
  }

  return { restoredCount: restored };
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

  if (msg.type === "pc:restoreTabs") {
    (async () => {
      try {
        const result = await restoreTabs(msg.tabs);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error("TabEater: restoreTabs failed", err);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  return undefined;
});

if (chrome?.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    setupContextMenus();
  });
}
if (chrome?.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    setupContextMenus();
  });
}
setupContextMenus();
if (chrome?.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === CONTEXT_MENU_IDS.CLOSE_ACTIVE_DOMAIN) {
      closeActiveDomainFromContext(tab, info);
    }
  });
}
