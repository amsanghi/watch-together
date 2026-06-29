// WatchTogether — fullscreen redirector (runs in the page's MAIN world).
// When WatchTogether is active on the page, redirect fullscreen requests to the
// whole page (document.documentElement) instead of just the video element. That
// keeps the WatchTogether panel on-screen and in the normal layout during
// fullscreen — same interface as windowed, no iframe reload, no popover.
// When WatchTogether isn't active, fullscreen behaves normally.

(function () {
  "use strict";
  const active = () => document.documentElement.getAttribute("data-wt-active") === "1";
  const proto = Element.prototype;

  ["requestFullscreen", "webkitRequestFullscreen", "mozRequestFullScreen", "msRequestFullscreen"].forEach((name) => {
    const orig = proto[name];
    if (typeof orig !== "function") return;
    proto[name] = function () {
      if (active() && this !== document.documentElement) {
        try { return orig.apply(document.documentElement, arguments); }
        catch (e) { return orig.apply(this, arguments); }
      }
      return orig.apply(this, arguments);
    };
  });
})();
