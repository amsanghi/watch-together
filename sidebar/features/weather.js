// WatchTogether — "same sky": each partner can share their local weather
// (Open-Meteo, no API key) so you see each other's conditions. We only ever
// send the rounded summary, never coordinates. `S.myWeather` is shared state
// because it's re-sent on (re)connect.
//
// Exports: renderMyWeather, renderPartnerWeather, shareWeather, receiveWeather,
//   syncWeatherOnConnect, markWeatherShared.

import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { netSend } from "../core/net.js";
import { addSys } from "./chat.js";

let partnerWeather = null;

function wmoEmoji(code) {
  if (code === 0) return "☀️";
  if (code === 1 || code === 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
}
// Sits directly under each clock in the hero card, so no name prefix is needed.
export function renderMyWeather() {
  if (!S.myWeather) { $("my-weather").textContent = ""; return; }
  $("my-weather").textContent = `${wmoEmoji(S.myWeather.code)} ${S.myWeather.temp}°`;
}
export function renderPartnerWeather() {
  if (!partnerWeather) return;
  $("partner-weather").textContent = `${wmoEmoji(partnerWeather.code)} ${partnerWeather.temp}°`;
}
function setShareLabel(text) {
  const b = $("weather-btn"), s = b && b.querySelector("span");
  if (s) s.textContent = text; else if (b) b.textContent = text;
}
export function markWeatherShared() { setShareLabel("Update my sky"); }
export function shareWeather() {
  if (!navigator.geolocation) { addSys("Location isn't available on this device."); return; }
  setShareLabel("Finding you…");
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude, longitude } = pos.coords;
      // round to ~1km for privacy; we only ever send the summary, never coords
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}&current=temperature_2m,weather_code,is_day`);
      const d = await r.json();
      const c = d.current || {};
      S.myWeather = { temp: Math.round(c.temperature_2m), code: c.weather_code, isDay: c.is_day ? 1 : 0 };
      chrome.storage.local.set({ wt_weather: S.myWeather });
      setShareLabel("Update my sky");
      renderMyWeather();
      netSend({ t: "weather", ...S.myWeather });
    } catch (e) { setShareLabel("Share my sky"); addSys("Couldn't reach the weather service. Try again in a moment."); }
  }, () => { setShareLabel("Share my sky"); addSys("Location is blocked, so your sky can't be shared."); }, { timeout: 10000 });
}

// Partner sent their weather (net.js `weather` case).
export function receiveWeather(temp, code, isDay) {
  partnerWeather = { temp, code, isDay };
  renderPartnerWeather();
}

// Re-share our weather when a link (re)comes up (connection.js onConnected).
export function syncWeatherOnConnect() {
  if (S.myWeather) netSend({ t: "weather", ...S.myWeather });
}
