const root = typeof globalThis !== "undefined" ? globalThis : this;
const SETTINGS_KEY = "pc.settings";
const DEFAULTS = {
  enableSuggestions: true,
  enableInactiveSuggestion: true,
  inactiveThresholdMinutes: 30,
  suggestMinOpenTabsPerDomain: 3,
  decayDays: 14,
  maxHistory: 200,
  showQuickActions: true,
  theme: "auto",
};

const CONTEXT_MENU_TITLE = "Close all tabs from this domain";

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

  const createEntry = (contexts) => {
    try {
      const maybePromise = menus.create(
        {
          title: CONTEXT_MENU_TITLE,
          contexts,
          onclick: handleContextMenuClick,
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
        maybePromise.catch((err) => {
          if (err) {
            console.warn(
              `TabEater: context menu create promise failed (contexts: ${contexts.join(
                ","
              )})`,
              err
            );
          }
        });
      }
    } catch (err) {
      console.warn(
        `TabEater: context menu create threw (contexts: ${contexts.join(
          ","
        )})`,
        err
      );
    }
  };

  const contextsToAdd = [["page", "frame"]];
  if (chrome?.action) contextsToAdd.push(["action"]);
  if (chrome?.browserAction) contextsToAdd.push(["browser_action"]);
  if (typeof browser !== "undefined" && browser.browserAction) {
    contextsToAdd.push(["browser_action"]);
  }

  const runCreate = () => {
    const seen = new Set();
    contextsToAdd.forEach((ctx) => {
      const key = ctx.join(",");
      if (seen.has(key)) return;
      seen.add(key);
      createEntry(ctx);
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
    const statsEat = root.pcStatsEat;
    if (typeof statsEat === "function") {
      try {
        await statsEat({ count: toClose.length });
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
    const statsEat = root.pcStatsEat;
    if (typeof statsEat === "function") {
      try {
        await statsEat({ count: toClose.length });
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
