// Standalone driver page. It intentionally never fetches transcript, route, map, or place-name
// data: its network activity is limited to session selection, driver analyses, weather, and this
// device's location uploads.
// The API key is configured on the regular viewer when needed. Driver mode deliberately has no
// settings UI, but reuses that saved key so it can remain a glance-only screen.
const savedApiKey = localStorage.getItem("apiKey") || "";
function apiHeaders() { return { "X-Api-Key": savedApiKey }; }
async function api(path, opts = {}) {
  const response = await fetch(path, {
    ...opts,
    headers: { ...apiHeaders(), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!response.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${response.status}`);
  return response.status === 204 ? null : response.json();
}

const headlineEl = document.getElementById("driverHeadline");
const actionEl = document.getElementById("driverAction");
const watchEl = document.getElementById("driverWatch");
const urgencyEl = document.getElementById("driverUrgency");
const weatherEl = document.getElementById("driverWeather");
const weatherRainEl = document.getElementById("driverWeatherRain");
const weatherTempEl = document.getElementById("driverWeatherTemp");
const weatherHumidityEl = document.getElementById("driverWeatherHumidity");
const weatherWindEl = document.getElementById("driverWeatherWind");
const weatherForecastEl = document.getElementById("driverWeatherForecast");
const speedEl = document.getElementById("driverSpeed");
const speedValueEl = document.getElementById("driverSpeedValue");
const speedSourceEl = document.getElementById("driverSpeedSource");
const metaEl = document.getElementById("driverMeta");
const connectionEl = document.getElementById("driverConnection");

const requestedSession = new URLSearchParams(location.search).get("session");
const followLatest = !requestedSession || requestedSession === "latest";
let sessionId = followLatest ? null : requestedSession;
let snapshot = null;
let weather = null;
let weatherFetchedAt = 0;
let locationWatchId = null;
let locationBuffer = [];
let locationSendInFlight = false;
let lastAnalysisSignature = "";
let lastSessionCheckAt = 0;
let weatherInFlight = false;
let previousSpeedSample = null;
// A stopped driver must still see a speed value. Some browsers leave coords.speed unset
// while stationary, so start at zero and replace it as soon as GPS or movement supplies one.
let latestSpeedMps = 0;
let latestSpeedSource = "";

function setConnection(ok) {
  connectionEl.classList.toggle("error", !ok);
  connectionEl.setAttribute("aria-label", ok ? "接続中" : "通信エラー");
  connectionEl.title = ok ? "接続中" : "通信エラー";
}

function relativeAge(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 15) return "たった今";
  if (seconds < 60) return `${seconds}秒前`;
  return `${Math.floor(seconds / 60)}分前`;
}

async function syncSession(force = false) {
  if (!followLatest || (!force && Date.now() - lastSessionCheckAt < 10_000)) return;
  lastSessionCheckAt = Date.now();
  const sessions = await api("/api/sessions");
  const newest = sessions[0];
  if (!newest || newest.id === sessionId) return;
  sessionId = newest.id;
  weather = null;
  snapshot = null;
  weatherFetchedAt = 0;
  lastAnalysisSignature = "";
}

function renderWeather() {
  const rainEta = Number(weather?.rainForecast?.etaMinutes);
  const rainProbability = Number(weather?.rainForecast?.probability);
  const forecastEta = Number(weather?.weatherForecast?.etaMinutes);
  let forecast = "";
  if (Number.isFinite(rainEta) && rainEta <= 180 && Number.isFinite(rainProbability)) {
    forecast = `${rainEta <= 5 ? "まもなく" : `${rainEta}分後`} ☔️ ${Math.round(rainProbability)}%`;
  } else if (Number.isFinite(forecastEta) && forecastEta <= 180 && weather?.weatherForecast?.weather) {
    const text = weather.weatherForecast.weather;
    forecast = `${forecastEta <= 5 ? "まもなく" : `${forecastEta}分後`} ${text.includes("晴") ? "☀️" : text.includes("雪") ? "❄️" : "☁️"} ${text}`;
  }
  const rain = snapshot?.isRaining === true ? "☔️" : snapshot?.isRaining === false ? "☀️" : "—";
  const temperature = typeof snapshot?.temperatureC === "number" ? `${snapshot.temperatureC.toFixed(0)}°` : "—";
  const humidity = typeof snapshot?.humidityPercent === "number" ? `${snapshot.humidityPercent.toFixed(0)}%` : "—";
  const wind = typeof snapshot?.windSpeedMs === "number" ? `${snapshot.windSpeedMs.toFixed(1)} m/s` : "—";
  weatherRainEl.textContent = rain;
  weatherTempEl.textContent = temperature;
  weatherHumidityEl.textContent = humidity;
  weatherWindEl.textContent = wind;
  weatherForecastEl.textContent = forecast;
  weatherForecastEl.hidden = !forecast;
  renderSpeed();
  weatherEl.hidden = !forecast && !snapshot;
}

function renderSpeed() {
  speedValueEl.textContent = `${Math.round(latestSpeedMps * 3.6)} km/h`;
  speedSourceEl.textContent = latestSpeedSource;
}

function renderAnalysis(entries) {
  const driverEntries = entries.filter((entry) => entry.mode === "driver");
  const latest = driverEntries.at(-1);
  const completed = [...driverEntries].reverse().find((entry) => entry.status === "done" && entry.result);
  const shown = latest?.status === "queued" || latest?.status === "running" ? completed : latest;
  if (!shown?.result) {
    headlineEl.textContent = latest ? "解析中…" : "ドライバー解析待ち";
    actionEl.hidden = true;
    watchEl.hidden = true;
    metaEl.textContent = latest ? "新しい解析を更新中" : "アプリで解析を実行すると表示されます";
    return;
  }
  const result = shown.result;
  const urgency = { low: "低", medium: "中", high: "高" }[result.urgency] || "低";
  urgencyEl.textContent = `緊急度: ${urgency}`;
  urgencyEl.className = `urgency ${result.urgency || "low"}`;
  headlineEl.textContent = result.headline || "-";
  actionEl.textContent = `▶ ${result.action || "-"}`;
  actionEl.hidden = false;
  watchEl.textContent = result.watch ? `⚠ ${result.watch}` : "";
  watchEl.hidden = !result.watch;
  metaEl.textContent = latest !== shown ? `${relativeAge(shown.created_at)} · 新しい解析を更新中` : relativeAge(shown.created_at);
}

async function refreshAnalyses() {
  if (!sessionId) return;
  const entries = await api(`/api/sessions/${sessionId}/analyses`);
  const signature = JSON.stringify(entries.map((entry) => [entry.id, entry.status, entry.updated_at]));
  if (signature !== lastAnalysisSignature) {
    lastAnalysisSignature = signature;
    renderAnalysis(entries);
  }
}

async function refreshWeather(force = false) {
  if (weatherInFlight || !sessionId || (!force && Date.now() - weatherFetchedAt < 60_000)) return;
  const requestedId = sessionId;
  weatherInFlight = true;
  try {
    const data = await api(`/api/sessions/${requestedId}/weather`);
    if (sessionId !== requestedId) return;
    weather = data.weather || null;
    snapshot = data.snapshot || null;
    weatherFetchedAt = Date.now();
    renderWeather();
  } finally {
    weatherInFlight = false;
  }
}

async function tick() {
  try {
    await syncSession();
    await Promise.all([refreshAnalyses(), refreshWeather()]);
    setConnection(true);
  } catch (error) {
    console.warn("driver page refresh failed", error);
    setConnection(false);
  }
}

function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const lat1 = a.lat * radians;
  const lat2 = b.lat * radians;
  const dLat = (b.lat - a.lat) * radians;
  const dLng = (b.lng - a.lng) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function estimatedSpeedMps(previous, current) {
  if (!previous) return null;
  const elapsedSeconds = (current.recordedAtMs - previous.recordedAtMs) / 1_000;
  // Very short samples are GPS jitter; long gaps are no longer a live-speed estimate.
  if (elapsedSeconds < 1 || elapsedSeconds > 30) return null;
  const speed = distanceMeters(previous, current) / elapsedSeconds;
  return Number.isFinite(speed) && speed <= 100 ? speed : null;
}

function pointFromPosition(position) {
  const coords = position.coords;
  const sample = { lat: coords.latitude, lng: coords.longitude, recordedAtMs: position.timestamp };
  const nativeSpeed = typeof coords.speed === "number" && Number.isFinite(coords.speed) && coords.speed >= 0
    ? coords.speed
    : null;
  const calculatedSpeed = nativeSpeed === null ? estimatedSpeedMps(previousSpeedSample, sample) : null;
  const speedMps = nativeSpeed ?? calculatedSpeed;
  previousSpeedSample = sample;
  if (speedMps !== null) {
    latestSpeedMps = speedMps;
    latestSpeedSource = nativeSpeed !== null ? "GPS" : "位置差から算出";
    renderSpeed();
  }

  const point = { lat: coords.latitude, lng: coords.longitude, recordedAt: new Date(position.timestamp).toISOString() };
  if (typeof coords.accuracy === "number" && !Number.isNaN(coords.accuracy)) point.accuracyM = coords.accuracy;
  if (speedMps !== null) point.speedMps = speedMps;
  if (typeof coords.heading === "number" && !Number.isNaN(coords.heading)) point.bearingDeg = coords.heading;
  return point;
}

async function flushLocationBuffer() {
  if (locationSendInFlight || locationBuffer.length === 0 || !sessionId) return;
  const batch = locationBuffer.splice(0, 3);
  locationSendInFlight = true;
  try {
    await api(`/api/sessions/${sessionId}/locations`, { method: "POST", body: JSON.stringify({ locations: batch }) });
  } catch (error) {
    console.warn("driver location send failed", error);
    locationBuffer = [...batch, ...locationBuffer].slice(0, 10);
  } finally {
    locationSendInFlight = false;
  }
}

function startLocationWatch() {
  if (locationWatchId !== null || !window.isSecureContext || !navigator.geolocation) return;
  locationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      locationBuffer.push(pointFromPosition(position));
      if (locationBuffer.length > 10) locationBuffer.shift();
      if (locationBuffer.length >= 3) flushLocationBuffer();
    },
    (error) => console.warn("driver location unavailable", error),
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 }
  );
}

tick();
setInterval(tick, 3_000);
setInterval(flushLocationBuffer, 3_000);
startLocationWatch();
