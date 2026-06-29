// WatchTogether — background service worker (MV3)
// Toolbar click toggles the in-page panel for the active tab. If the content
// script isn't there yet (tab was open before the extension loaded/updated),
// inject it on the fly so the icon always works without reloading the page.

async function toggle(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { wt: "toggle" });
  } catch (_) {
    // No receiver yet — inject the content script + styles, then toggle.
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tabId, { wt: "toggle" });
    } catch (e) {
      // Restricted page (chrome://, Web Store, new-tab, PDF viewer) — can't inject.
      console.warn("WatchTogether can't run on this page:", e?.message || e);
    }
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) toggle(tab.id);
});
