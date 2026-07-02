// WatchTogether — "same sky": each partner can share their local weather
// (Open-Meteo, no API key) so you see each other's conditions. We only ever
// send the rounded summary, never coordinates. `S.myWeather` is shared state
// because it's re-sent on (re)connect.
//
// Exports: renderMyWeather, renderPartnerWeather, shareWeather, receiveWeather,
//   syncWeatherOnConnect.

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
export function renderMyWeather() {
  if (!S.myWeather) { $("my-weather").textContent = ""; return; }
  $("my-weather").textContent = `${S.myWeather.isDay ? "☀️" : "🌙"} You: ${wmoEmoji(S.myWeather.code)} ${S.myWeather.temp}°C`;
}
export function renderPartnerWeather() {
  if (!partnerWeather) return;
  $("partner-weather").textContent = `${partnerWeather.isDay ? "☀️" : "🌙"} ${S.settings.partner}: ${wmoEmoji(partnerWeather.code)} ${partnerWeather.temp}°C`;
}
export function shareWeather() {
  if (!navigator.geolocation) { addSys("Location isn't available on this device."); return; }
  $("weather-btn").textContent = "Getting location…";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude, longitude } = pos.coords;
      // round to ~1km for privacy; we only ever send the summary, never coords
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}&current=temperature_2m,weather_code,is_day`);
      const d = await r.json();
      const c = d.current || {};
      S.myWeather = { temp: Math.round(c.temperature_2m), code: c.weather_code, isDay: c.is_day ? 1 : 0 };
      chrome.storage.local.set({ wt_weather: S.myWeather });
      $("weather-btn").textContent = "Update my weather 🔄";
      renderMyWeather();
      netSend({ t: "weather", ...S.myWeather });
    } catch (e) { $("weather-btn").textContent = "Share my weather"; addSys("Couldn't fetch the weather right now."); }
  }, () => { $("weather-btn").textContent = "Share my weather"; addSys("Location permission denied — can't share weather."); }, { timeout: 10000 });
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
