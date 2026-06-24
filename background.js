const USAGE_KEY = 'bookmarkUsage';
const INSTALL_KEY = 'installDate';

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(INSTALL_KEY);
  if (!existing[INSTALL_KEY]) {
    await chrome.storage.local.set({ [INSTALL_KEY]: Date.now() });
  }
});

// Track every completed main-frame navigation against stored bookmarks
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const url = details.url;
  if (!url || url.startsWith('chrome') || url.startsWith('about:') || url.startsWith('file:')) return;

  try {
    const bookmarks = await chrome.bookmarks.search({ url });
    if (!bookmarks.length) return;

    const stored = await chrome.storage.local.get(USAGE_KEY);
    const usage = stored[USAGE_KEY] || {};
    const now = Date.now();

    for (const bm of bookmarks) {
      if (!bm.url) continue;
      if (!usage[bm.id]) {
        usage[bm.id] = { url: bm.url, visitCount: 0, lastVisited: null, firstTracked: now };
      }
      usage[bm.id].visitCount += 1;
      usage[bm.id].lastVisited = now;
    }

    await chrome.storage.local.set({ [USAGE_KEY]: usage });
  } catch (_) {
    // bookmark may have been deleted since the navigation started
  }
});
