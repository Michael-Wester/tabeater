const root = typeof globalThis !== "undefined" ? globalThis : this;
const SETTINGS_KEY = "pc.settings";
const DEFAULTS = {
  enableInactiveSuggestion: true,
  inactiveThresholdMinutes: 120,
  suggestMinOpenTabsPerDomain: 1,
  decayDays: 14,
  maxHistory: 100000,
  showQuickActions: true,
  theme: "light",
};

function normalizeSettings(raw) {
  const settings = { ...DEFAULTS, ...(raw || {}) };
  delete settings.enableSuggestions;
  return settings;
}

const ACTION_ICON_PATHS = {
  active: {
    16: "icons/icon16.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
};

const CONTEXT_MENU_TITLE = "Close site tabs";
const CONTEXT_MENU_SORT_TITLE = "Sort tabs (most opened first)";
const CLOSE_MENU_ID_PAGE = "tabEater-close-site-tabs-page";

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

function getActionApi() {
  if (typeof chrome !== "undefined") {
    if (chrome.action) return chrome.action;
    if (chrome.browserAction) return chrome.browserAction;
  }
  if (typeof browser !== "undefined") {
    if (browser.action) return browser.action;
    if (browser.browserAction) return browser.browserAction;
  }
  return null;
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function tabLooksInactive(tab, thresholdMs, nowTs) {
  if (!tab || tab.incognito) return false;
  if (tab.pinned || tab.audible) return false;
  if (tab.active) return false;
  const last = tab.lastAccessed || 0;
  if (last) return nowTs - last >= thresholdMs;
  return tab.discarded === true;
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
function tabsMove(id, index) {
  return new Promise((resolve, reject) => {
    chrome.tabs.move(id, { index }, (tab) => {
      const err = getRuntimeLastError();
      if (err) reject(err);
      else resolve(tab);
    });
  });
}

// Context menu helpers

let lastIconKind = null;
let iconRefreshTimer = null;
let contextMenuClickBound = false;
async function setActionIcon() {
  const api = getActionApi();
  if (!api || typeof api.setIcon !== "function") return;
  if (lastIconKind === "active") return;
  const path = ACTION_ICON_PATHS.active;
  try {
    const maybePromise = api.setIcon({ path });
    if (maybePromise && typeof maybePromise.then === "function") {
      await maybePromise;
    }
    lastIconKind = "active";
  } catch (err) {
    console.warn("TabEater: unable to set action icon", err);
  }
}

async function refreshActionIcon() {
  const api = getActionApi();
  if (!api || typeof api.setIcon !== "function") return;
  try {
    await setActionIcon();
  } catch (err) {
    console.warn("TabEater: icon refresh failed", err);
  }
}

function scheduleIconRefresh(delay = 250) {
  if (iconRefreshTimer) return;
  iconRefreshTimer = setTimeout(() => {
    iconRefreshTimer = null;
    refreshActionIcon();
  }, delay);
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
function getRuntimeLastError() {
  if (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.lastError
  ) {
    return chrome.runtime.lastError;
  }
  if (
    typeof browser !== "undefined" &&
    browser.runtime &&
    browser.runtime.lastError
  ) {
    return browser.runtime.lastError;
  }
  return null;
}
async function handleContextMenuClick(info, tab) {
  let url =
    tab?.url ||
    info?.pageUrl ||
    info?.frameUrl ||
    info?.linkUrl ||
    info?.srcUrl ||
    "";
  if (!url) {
    try {
      const activeTabs = await tabsQuery({ active: true, currentWindow: true });
      url = activeTabs[0]?.url || "";
    } catch (err) {
      console.warn(
        "TabEater: unable to resolve active tab for context menu",
        err
      );
    }
  }
  let domain = null;
  try {
    domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {}
  if (!domain) return;
  try {
    await closeByKeyword(domain);
  } catch (err) {
    console.error("TabEater: context menu action failed", err);
  }
}

function installContextMenu() {
  const menus =
    (typeof chrome !== "undefined" && chrome.contextMenus) ||
    (typeof browser !== "undefined" && (browser.contextMenus || browser.menus));
  if (!menus || typeof menus.create !== "function") return;

  const createEntry = (title, contexts, id) => {
    try {
      const maybePromise = menus.create(
        {
          id,
          title,
          contexts,
        },
        () => {
          const err = getRuntimeLastError();
          if (err && err.message) {
            console.warn(
              `TabEater: context menu create failed (contexts: ${contexts.join(
                ","
              )})`,
              err
            );
          }
        }
      );
      if (maybePromise && typeof maybePromise.then === "function") {
        return maybePromise.catch((err) => {
          if (err) {
            console.warn(
              `TabEater: context menu create promise failed (contexts: ${contexts.join(
                ","
              )})`,
              err
            );
          }
          return null;
        });
      }
      // Synchronous ID return path.
      return maybePromise;
    } catch (err) {
      console.warn(
        `TabEater: context menu create threw (contexts: ${contexts.join(",")})`,
        err
      );
    }
    return null;
  };

  const tabContext =
    (menus.ContextType && (menus.ContextType.TAB || menus.ContextType.tab)) ||
    "tab";
  const supportsTabContext =
    !!(menus.ContextType && (menus.ContextType.TAB || menus.ContextType.tab)) ||
    (typeof browser !== "undefined" && (browser.contextMenus || browser.menus));
  const baseContexts = [
    "page",
    "selection",
    "link",
    "editable",
    "image",
    "video",
    "audio",
  ];
  const contextsToAdd = [
    {
      id: CLOSE_MENU_ID_PAGE,
      contexts: supportsTabContext
        ? [...baseContexts, tabContext]
        : baseContexts,
    },
  ];
  const sortContexts = [];

  const runCreate = () => {
    contextsToAdd.forEach((entry) => {
      createEntry(CONTEXT_MENU_TITLE, entry.contexts, entry.id);
    });
    const seenSort = new Set();
    sortContexts.forEach((ctx) => {
      const key = ctx.join(",");
      if (seenSort.has(key)) return;
      // Only register contexts supported in this browser.
      const ctxName = ctx[0];
      if (ctxName === "action" && !chrome?.action && !browser?.action) return;
      if (
        ctxName === "browser_action" &&
        !chrome?.browserAction &&
        !(typeof browser !== "undefined" && browser.browserAction)
      ) {
        return;
      }
      seenSort.add(key);
      createEntry(CONTEXT_MENU_SORT_TITLE, ctx, CONTEXT_MENU_SORT_TITLE);
    });
  };

  if (typeof menus.removeAll === "function") {
    try {
      const maybePromise = menus.removeAll();
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise
          .catch((err) => {
            if (err)
              console.warn("TabEater: context menu removeAll failed", err);
          })
          .finally(runCreate);
      } else {
        menus.removeAll(() => {
          const err = getRuntimeLastError();
          if (err && err.message) {
            console.warn("TabEater: context menu removeAll failed", err);
          }
          runCreate();
        });
      }
    } catch (err) {
      console.warn("TabEater: context menu removeAll threw", err);
      runCreate();
    }
  } else {
    runCreate();
  }

  if (
    !contextMenuClickBound &&
    menus.onClicked &&
    typeof menus.onClicked.addListener === "function"
  ) {
    menus.onClicked.addListener((info, tab) => {
      if (info?.menuItemId === CLOSE_MENU_ID_PAGE) {
        handleContextMenuClick(info, tab);
        return;
      }
      if (info?.menuItemId === CONTEXT_MENU_SORT_TITLE) {
        sortTabsByOpenCount().catch((err) => {
          console.error("TabEater: context sort failed", err);
        });
      }
    });
    contextMenuClickBound = true;
  }

}

function getSettings() {
  return new Promise((res) => {
    chrome.storage.local.get(SETTINGS_KEY, (raw) => {
      res(normalizeSettings(raw?.[SETTINGS_KEY]));
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
    const statsEat = root.pcStatsEat;
    if (typeof statsEat === "function") {
      try {
        await statsEat({ count: toClose.length });
      } catch {}
    }
  }

  scheduleIconRefresh();
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
    if (!tabLooksInactive(tab, thresholdMs, nowTs)) continue;
    toClose.push(tab.id);
    const d = domainFromUrl(tab.url);
    if (d) closedDomains.add(d);
    const snapshot = serializeTab(tab);
    if (snapshot) closedTabs.push(snapshot);
  }

  if (toClose.length) {
    await tabsRemove(toClose);
    const statsEat = root.pcStatsEat;
    if (typeof statsEat === "function") {
      try {
        await statsEat({ count: toClose.length });
      } catch {}
    }
    scheduleIconRefresh();
  }

  return {
    closedCount: toClose.length,
    closedDomains: Array.from(closedDomains),
    closedTabs,
  };
}

function normalizeUrlForDedup(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

async function closeDuplicateTabs() {
  const tabs = await tabsQuery({});
  const seen = new Set();
  const toClose = [];
  const closedDomains = new Set();
  const closedTabs = [];

  for (const tab of tabs) {
    if (tab.incognito || tab.pinned) continue;
    const key = normalizeUrlForDedup(tab.url || tab.pendingUrl || "");
    if (!key) continue;
    if (seen.has(key)) {
      toClose.push(tab.id);
      const d = domainFromUrl(tab.url);
      if (d) closedDomains.add(d);
      const snapshot = serializeTab(tab);
      if (snapshot) closedTabs.push(snapshot);
    } else {
      seen.add(key);
    }
  }

  if (toClose.length) {
    await tabsRemove(toClose);
    const statsEat = root.pcStatsEat;
    if (typeof statsEat === "function") {
      try {
        await statsEat({ count: toClose.length });
      } catch {}
    }
    scheduleIconRefresh();
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

  scheduleIconRefresh();
  return { restoredCount: restored };
}

async function sortTabsByOpenCount() {
  const tabs = await tabsQuery({ currentWindow: true });
  if (!Array.isArray(tabs) || tabs.length <= 1) return { sortedCount: 0 };

  const ordered = [...tabs].sort((a, b) => (a.index || 0) - (b.index || 0));
  const domainCounts = new Map();
  const movable = [];
  let pinnedCount = 0;

  for (const tab of ordered) {
    const domain = domainFromUrl(tab.url) || "";
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    if (tab.pinned) {
      pinnedCount += 1;
      continue;
    }
    movable.push({
      tabId: tab.id,
      domain,
      originalIndex: typeof tab.index === "number" ? tab.index : Number.MAX_SAFE_INTEGER,
    });
  }

  if (movable.length <= 1) return { sortedCount: 0 };

  movable.sort((a, b) => {
    const countDiff =
      (domainCounts.get(b.domain) || 0) - (domainCounts.get(a.domain) || 0);
    if (countDiff !== 0) return countDiff;
    if (!a.domain && b.domain) return 1;
    if (a.domain && !b.domain) return -1;
    const cmp = (a.domain || "").localeCompare(b.domain || "");
    if (cmp !== 0) return cmp;
    return a.originalIndex - b.originalIndex;
  });

  let moved = 0;
  for (let i = 0; i < movable.length; i += 1) {
    const targetIndex = pinnedCount + i;
    const tabId = movable[i].tabId;
    if (typeof tabId !== "number") continue;
    try {
      await tabsMove(tabId, targetIndex);
      moved += 1;
    } catch (err) {
      console.warn("TabEater: sort move failed", err);
    }
  }

  return { sortedCount: moved };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "pc:closeByKeyword" && msg.query) {
    (async () => {
      sendResponse({ ok: true, ...(await closeByKeyword(msg.query)) });
    })();
    return true;
  }

  if (msg.type === "pc:sortTabsByOpenCount") {
    (async () => {
      try {
        const result = await sortTabsByOpenCount();
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error("TabEater: sortTabsByOpenCount failed", err);
        sendResponse({ ok: false });
      }
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

  if (msg.type === "pc:closeDuplicates") {
    (async () => {
      try {
        const result = await closeDuplicateTabs();
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error("TabEater: closeDuplicateTabs failed", err);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  return undefined;
});

const tabsApi =
  (typeof chrome !== "undefined" && chrome.tabs) ||
  (typeof browser !== "undefined" && browser.tabs);
if (tabsApi?.onCreated) tabsApi.onCreated.addListener(scheduleIconRefresh);
if (tabsApi?.onRemoved) tabsApi.onRemoved.addListener(scheduleIconRefresh);
if (tabsApi?.onActivated) tabsApi.onActivated.addListener(scheduleIconRefresh);
if (tabsApi?.onUpdated) tabsApi.onUpdated.addListener(scheduleIconRefresh);
if (tabsApi?.onReplaced) tabsApi.onReplaced.addListener(scheduleIconRefresh);

const storageApi =
  (typeof chrome !== "undefined" && chrome.storage) ||
  (typeof browser !== "undefined" && browser.storage);
if (storageApi?.onChanged) {
  storageApi.onChanged.addListener((changes, area) => {
    if (area === "local" && changes?.[SETTINGS_KEY]) {
      scheduleIconRefresh();
    }
  });
}

const runtimeApi =
  (typeof chrome !== "undefined" && chrome.runtime) ||
  (typeof browser !== "undefined" && browser.runtime) ||
  null;
if (runtimeApi?.onInstalled) {
  runtimeApi.onInstalled.addListener(installContextMenu);
}
if (runtimeApi?.onStartup) {
  runtimeApi.onStartup.addListener(installContextMenu);
}
installContextMenu();
refreshActionIcon();
