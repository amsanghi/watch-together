// WatchTogether — Netflix main-world bridge.
// Netflix plays via Media Source Extensions, not a plain HTML5 <video>, so
// setting video.currentTime directly throws its player into the "we're having
// trouble with your request" error. Instead we drive Netflix's own player API
// (seek/play/pause). That API only exists in the page's MAIN world, which is
// why this runs as a world:"MAIN" content script. It receives commands from the
// isolated content script (content.js) over window.postMessage.

(function () {
  "use strict";

  function getPlayer() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      if (!ids || !ids.length) return null;
      return vp.getVideoPlayerBySessionId(ids[0]);
    } catch (e) {
      return null;
    }
  }

  window.addEventListener("message", function (e) {
    const d = e.data;
    if (e.source !== window || !d || d.__wtNetflix !== true) return;
    const p = getPlayer();
    if (!p) return;
    try {
      if (d.cmd === "seek" && typeof d.time === "number") p.seek(Math.round(d.time * 1000));
      else if (d.cmd === "play") p.play();
      else if (d.cmd === "pause") p.pause();
    } catch (err) {
      /* player not ready / transient — ignore */
    }
  });
})();
