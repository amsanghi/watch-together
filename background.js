// WatchTogether — background service worker (MV3)
// Toolbar click toggles the in-page panel for the active tab.

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { wt: "toggle" }).catch(() => {
    // No content script on this page (e.g. chrome:// pages). Ignore.
  });
});
