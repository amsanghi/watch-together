// WatchTogether — storage helper.
//
// chrome.storage.local can hit its quota once the gallery / scrapbook fill up with
// base64 photos and clips, after which a plain `set()` fails *silently* and new
// items just don't save. saveWithQuota retries once after letting the caller shrink
// its own collection, so the newest items still land instead of being dropped.
//
// Exports: saveWithQuota.

export function saveWithQuota(key, getValue, shrink) {
  const write = (retried) => {
    try {
      chrome.storage.local.set({ [key]: getValue() }, () => {
        const err = chrome.runtime.lastError;
        if (err && !retried && /quota/i.test(err.message || "")) {
          try { shrink(); } catch (_) {}
          write(true);
        }
      });
    } catch (_) {}
  };
  write(false);
}
