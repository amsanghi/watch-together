// WatchTogether — background service worker (MV3).
// The UI + P2P connection live in the Side Panel (one per window, persists
// across tab switches/navigation). The toolbar icon and the keyboard shortcut
// open it.

// Clicking the toolbar icon opens the side panel natively.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// Keyboard shortcut (Cmd/Ctrl+Shift+Y) opens the side panel in the current window.
chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-panel") return;
  chrome.windows.getCurrent().then((win) => {
    if (win && win.id != null) chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
  });
});
