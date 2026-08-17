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
const weatherPopEl = document.getElementById("driverWeatherPop");
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
let precipitation = null;
let weatherFetchedAt = 0;
let locationWatchId = null;
let locationBuffer = [];
// The last point actually queued for upload — the distance gate measures from here, not from
// the previous fix, so slow drift can never accumulate into a recorded point.
let lastRecordedPoint = null;
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
  precipitation = null;
  // A new session has no points yet, so the next fix must be recorded however little the car
  // has moved — otherwise its weather stays unavailable until the 100 m gate happens to open.
  lastRecordedPoint = null;
  weatherFetchedAt = 0;
  lastAnalysisSignature = "";
}

/** JMA publishes probability per six-hour slot, so the driver is shown the slot actually being
 * driven through, falling back to the next one when the current slot has already been dropped. */
function currentProbabilitySlot() {
  const slots = precipitation?.slots;
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const now = Date.now();
  return (
    slots.find((slot) => new Date(slot.startAt).getTime() <= now && now < new Date(slot.endAt).getTime()) ??
    slots.find((slot) => new Date(slot.startAt).getTime() > now) ??
    null
  );
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
  const probabilitySlot = currentProbabilitySlot();
  const temperature = typeof snapshot?.temperatureC === "number" ? `${snapshot.temperatureC.toFixed(0)}°` : "—";
  const humidity = typeof snapshot?.humidityPercent === "number" ? `${snapshot.humidityPercent.toFixed(0)}%` : "—";
  // The unit lives in this cell's label so every value in the strip stays a bare number.
  const wind = typeof snapshot?.windSpeedMs === "number" ? snapshot.windSpeedMs.toFixed(1) : "—";
  weatherRainEl.textContent = rain;
  weatherPopEl.textContent = probabilitySlot ? `${Math.round(probabilitySlot.probability)}%` : "—";
  weatherPopEl.classList.toggle("high", (probabilitySlot?.probability ?? 0) >= 50);
  weatherTempEl.textContent = temperature;
  weatherHumidityEl.textContent = humidity;
  weatherWindEl.textContent = wind;
  weatherForecastEl.textContent = forecast;
  weatherForecastEl.hidden = !forecast;
  renderSpeed();
  weatherEl.hidden = !forecast && !snapshot && !probabilitySlot;
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
    precipitation = data.precipitation || null;
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
  const accuracyM = typeof coords.accuracy === "number" && Number.isFinite(coords.accuracy) ? coords.accuracy : null;
  // A fix this vague cannot say where the car is, so it cannot say how fast it is going either.
  // One 399 m reading mid-drive dropped the readout from 68 km/h to 8 km/h and left it there.
  const speedIsTrustworthy = accuracyM === null || accuracyM <= SPEED_MAX_ACCURACY_M;
  const nativeSpeed = typeof coords.speed === "number" && Number.isFinite(coords.speed) && coords.speed >= 0
    ? coords.speed
    : null;
  const calculatedSpeed = nativeSpeed === null ? estimatedSpeedMps(previousSpeedSample, sample) : null;
  const speedMps = nativeSpeed ?? calculatedSpeed;
  previousSpeedSample = sample;
  if (speedMps !== null && speedIsTrustworthy) {
    latestSpeedMps = speedMps;
    latestSpeedSource = nativeSpeed !== null ? "GPS" : "位置差から算出";
    renderSpeed();
  }

  const point = { lat: coords.latitude, lng: coords.longitude, recordedAt: new Date(position.timestamp).toISOString() };
  if (accuracyM !== null) point.accuracyM = accuracyM;
  // Storing a speed we would not show would put the same wrong number into 区間時刻履歴's average.
  if (speedMps !== null && speedIsTrustworthy) point.speedMps = speedMps;
  if (typeof coords.heading === "number" && !Number.isNaN(coords.heading)) point.bearingDeg = coords.heading;
  return point;
}

// One point per 100 m of travel. The server keeps every point it is given, so recording each
// GPS fix filled the table with near-identical rows whenever the car was not moving.
const LOCATION_RECORD_DISTANCE_M = 100;
// ...but a parked car must still report where it is, because the weather endpoints refuse a
// location older than 10 minutes and the driver's weather strip would go blank exactly when
// someone has time to look at it. Half that window keeps it fresh without filling the table.
const LOCATION_RECORD_MAX_GAP_MS = 5 * 60 * 1000;
const SPEED_MAX_ACCURACY_M = 50;
// Each buffered point is now 100 m of road rather than one of many fixes a few metres apart, so
// losing one leaves a visible hole in the track. Hold roughly 6 km of travel across a tunnel or a
// dead spot, and hand the server as many as it accepts per request instead of three at a time.
const LOCATION_BUFFER_MAX = 60;
const LOCATION_BATCH_MAX = 50;

function shouldRecord(point) {
  if (!lastRecordedPoint) return true;
  if (distanceMeters(lastRecordedPoint, point) >= LOCATION_RECORD_DISTANCE_M) return true;
  const elapsed = new Date(point.recordedAt).getTime() - new Date(lastRecordedPoint.recordedAt).getTime();
  return !Number.isFinite(elapsed) || elapsed >= LOCATION_RECORD_MAX_GAP_MS;
}

async function flushLocationBuffer() {
  if (locationSendInFlight || locationBuffer.length === 0 || !sessionId) return;
  const batch = locationBuffer.splice(0, LOCATION_BATCH_MAX);
  locationSendInFlight = true;
  try {
    await api(`/api/sessions/${sessionId}/locations`, { method: "POST", body: JSON.stringify({ locations: batch }) });
  } catch (error) {
    console.warn("driver location send failed", error);
    // Oldest first: on a long outage the start of the gap is the part the track cannot infer.
    locationBuffer = [...batch, ...locationBuffer].slice(0, LOCATION_BUFFER_MAX);
  } finally {
    locationSendInFlight = false;
  }
}

function startLocationWatch() {
  if (locationWatchId !== null || !window.isSecureContext || !navigator.geolocation) return;
  locationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      // Every fix still goes through pointFromPosition: speed is derived from consecutive
      // samples, and 100 m apart is far too coarse to derive it from. Only the recording is
      // thinned out.
      const point = pointFromPosition(position);
      if (!shouldRecord(point)) return;
      lastRecordedPoint = point;
      locationBuffer.push(point);
      if (locationBuffer.length > LOCATION_BUFFER_MAX) locationBuffer.shift();
      // Every point is 100 m of progress now, so send it rather than waiting for two more.
      flushLocationBuffer();
    },
    (error) => console.warn("driver location unavailable", error),
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 }
  );
}

tick();
setInterval(tick, 3_000);
setInterval(flushLocationBuffer, 3_000);
startLocationWatch();
