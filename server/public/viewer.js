// Read-only viewer: no session creation, no text input, no analyze trigger — just polls and
// renders a session's transcript + full analysis timeline (both default and pitwall entries).
const apiKeyInput = document.getElementById("apiKey");
apiKeyInput.value = localStorage.getItem("apiKey") || "";
apiKeyInput.addEventListener("input", () => {
  localStorage.setItem("apiKey", apiKeyInput.value);
});

function apiHeaders() {
  return { "X-Api-Key": apiKeyInput.value };
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...apiHeaders(), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!res.ok) {
    let apiError = "";
    try {
      const body = await res.json();
      apiError = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
    } catch {
      // A proxy or an older server can return a non-JSON error page. The status still identifies it.
    }
    const error = new Error(`${opts.method || "GET"} ${path} -> ${res.status}`);
    error.statusCode = res.status;
    error.apiError = apiError;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

const requestedSession = new URLSearchParams(location.search).get("session");
const noSessionSection = document.getElementById("noSessionSection");
const viewerSection = document.getElementById("viewerSection");
const segmentsEl = document.getElementById("segments");
const segmentsLatestBtn = document.getElementById("segmentsLatest");
const analysesEl = document.getElementById("analyses");
const statusSessionEl = document.getElementById("statusSession");
const statusConnectionEl = document.getElementById("statusConnection");
const statusSegCountEl = document.getElementById("statusSegCount");
const statusAnalysisCountEl = document.getElementById("statusAnalysisCount");
const statusLastUpdateEl = document.getElementById("statusLastUpdate");

function setStatusSession() {
  if (followLatest) {
    statusSessionEl.textContent = sessionId ? `最新 ${sessionId.slice(0, 8)}` : "最新追従中";
  } else {
    statusSessionEl.textContent = `セッション ${sessionId.slice(0, 8)}`;
  }
}

function setStatusConnection(ok) {
  statusConnectionEl.textContent = ok ? "接続中" : "通信エラー";
  statusConnectionEl.classList.toggle("status-error", !ok);
}

function setStatusLastUpdate() {
  statusLastUpdateEl.textContent = `更新 ${new Date().toLocaleTimeString("ja-JP")}`;
}

// "latest" (or no session param) follows whichever session is newest on the server, so the
// driver's screen keeps updating after the app starts a new session instead of silently
// freezing on a session id that stopped receiving data.
const followLatest = !requestedSession || requestedSession === "latest";
let sessionId = followLatest ? null : requestedSession;

async function syncLatestSession() {
  if (!followLatest) return;
  try {
    const sessions = await api("/api/sessions");
    const newest = sessions[0]; // server returns newest-first
    if (newest && newest.id !== sessionId) {
      sessionId = newest.id;
      // Wipe the previous session's content immediately rather than letting it linger until
      // the next poll paints over it.
      segmentsEl.innerHTML = "";
      analysesEl.innerHTML = "";
      setStatusSession();
      resetRouteSessionData();
    }
  } catch (err) {
    console.error(err);
  }
}

async function tick() {
  await syncLatestSession();
  if (!sessionId) return;
  refreshSegments();
  refreshAnalyses();
}

viewerSection.hidden = false;
setStatusSession();
tick();
setInterval(tick, 2000);

// Collapsed accordion panes shouldn't keep reserving their expanded grid track — a closed
// <details> already shrinks to just its <summary> on its own, so toggle a class on the grid
// container (#viewerSection) that switches that pane's column (desktop) / row (mobile) to
// `auto`, letting the still-open sibling(s) take the freed space. See viewer.css
// `#viewerSection.collapsed-*`.
document.querySelectorAll("#viewerSection > details").forEach((details) => {
  const key = details.id.replace("Details", ""); // segmentsDetails -> segments, etc.
  const sync = () => viewerSection.classList.toggle(`collapsed-${key}`, !details.open);
  details.addEventListener("toggle", sync);
  sync();
});

// Signatures of the last rendered data, so a poll that returns identical content leaves the DOM
// (and therefore any in-progress scroll gesture) completely untouched.
let lastSegmentsSignature = null;
let lastAnalysesSignature = null;

let segmentsAtBottom = true;
function updateSegmentsLatestButton() {
  if (!segmentsLatestBtn) return;
  const canScroll = segmentsEl.scrollHeight > segmentsEl.clientHeight + 1;
  segmentsLatestBtn.hidden = !canScroll || segmentsAtBottom;
}

function scrollSegmentsToLatest() {
  segmentsAtBottom = true;
  segmentsEl.scrollTop = segmentsEl.scrollHeight;
  updateSegmentsLatestButton();
}

segmentsEl.addEventListener("scroll", () => {
  segmentsAtBottom = segmentsEl.scrollHeight - segmentsEl.scrollTop - segmentsEl.clientHeight < 40;
  updateSegmentsLatestButton();
});
segmentsLatestBtn?.addEventListener("click", scrollSegmentsToLatest);

async function refreshSegments() {
  let session;
  try {
    session = await api(`/api/sessions/${sessionId}`);
  } catch (err) {
    console.error(err);
    setStatusConnection(false);
    return;
  }
  setStatusConnection(true);
  setStatusLastUpdate();
  const segments = session.segments || [];
  statusSegCountEl.textContent = `発話 ${segments.length}`;
  // Only touch the DOM when the data actually changed. Tearing the list down and rebuilding it
  // on every 2s poll cancels any in-progress touch scroll (the element under the finger is
  // destroyed mid-gesture), which made the panes feel completely unscrollable while idle.
  const signature = segments.map((s) => `${s.client_seq}:${s.excluded}:${s.text.length}`).join("|");
  if (signature === lastSegmentsSignature) return;
  lastSegmentsSignature = signature;

  const prevScrollTop = segmentsEl.scrollTop;
  segmentsEl.innerHTML = "";
  for (const seg of segments) {
    const div = document.createElement("div");
    div.className = "segment-line";
    const time = new Date(seg.created_at).toLocaleTimeString("ja-JP");
    const excludedMark = seg.excluded ? "🗄 " : "";
    div.innerHTML = `<span class="segment-time">${time}</span>${excludedMark}${escapeHtml(seg.text)}`;
    if (seg.excluded) div.style.opacity = "0.5";
    segmentsEl.appendChild(div);
  }
  if (segmentsAtBottom) scrollSegmentsToLatest();
  else {
    segmentsEl.scrollTop = prevScrollTop;
    updateSegmentsLatestButton();
  }
}

// Analyses render newest-first, so "following the live feed" means sitting at the top of the
// list rather than the bottom (the transcript below still reads oldest-first like a log).
let analysesAtTop = true;
analysesEl.addEventListener("scroll", () => {
  analysesAtTop = analysesEl.scrollTop < 40;
});

async function refreshAnalyses() {
  let list;
  try {
    list = await api(`/api/sessions/${sessionId}/analyses`);
  } catch (err) {
    console.error(err);
    setStatusConnection(false);
    return;
  }
  setStatusConnection(true);
  setStatusLastUpdate();
  statusAnalysisCountEl.textContent = `解析 ${list.length}`;
  // Same rebuild-only-on-change guard as the transcript above: a rebuild mid-gesture kills the
  // scroll. The HUD still updates every poll — it's cheap and doesn't own a scroll position.
  const signature = list.map((a) => `${a.id}:${a.status}`).join("|");
  if (signature !== lastAnalysesSignature) {
    lastAnalysesSignature = signature;
    const prevScrollTop = analysesEl.scrollTop;
    analysesEl.innerHTML = "";
    // Server returns oldest-first; reverse so the newest analysis is the first thing visible.
    for (const a of [...list].reverse()) {
      analysesEl.appendChild(renderAnalysisEntry(a));
    }
    analysesEl.scrollTop = analysesAtTop ? 0 : prevScrollTop;
  }
  updateDriverHud(list);
}

function renderAnalysisEntry(a) {
  const div = document.createElement("div");
  div.className = "analysis-entry";
  const time = new Date(a.created_at).toLocaleTimeString("ja-JP");
  const modeLabel =
    a.mode === "pitwall" ? "ピットウォール" : a.mode === "driver" ? "ドライバー" : "通常";
  const modeClass = a.mode === "pitwall" ? "pitwall" : a.mode === "driver" ? "driver" : "";
  let body = "";

  if (a.status === "queued") body = `<p class="status-queued">解析待ち…</p>`;
  else if (a.status === "running") body = `<p class="status-running">解析中…</p>`;
  else if (a.status === "error") body = `<p class="warn">エラー: ${escapeHtml(a.error || "不明")}</p>`;
  else if (a.status === "done" && a.result) {
    body =
      a.mode === "pitwall"
        ? renderPitwall(a.result)
        : a.mode === "driver"
          ? renderDriver(a.result)
          : renderDefault(a.result);
  } else {
    body = `<p>結果なし</p>`;
  }

  div.innerHTML = `<span class="entry-time">${time}</span><span class="entry-mode ${modeClass}">${modeLabel}</span>${body}`;
  return div;
}

function renderDefault(r) {
  const advice = (r.advice || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("");
  return `
    <h4>要約</h4><p>${escapeHtml(r.summary || "-")}</p>
    <h4>解釈</h4><p>${escapeHtml(r.interpretation || "-")}</p>
    <h4>アドバイス</h4><ul>${advice}</ul>
    <h4>返答案</h4><p>${escapeHtml(r.suggested_response || "-")}</p>
  `;
}

function renderPitwall(r) {
  const facts = (r.facts || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("");
  const warnings = (r.warnings || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("");
  const confidenceLabel = { low: "低", medium: "中", high: "高" }[r.confidence] || r.confidence;
  const proposalPrefix = r.needsReview ? "⚠ 要確認: " : "";
  return `
    <h4>状況</h4><p>${escapeHtml(r.statusSummary || "-")}</p>
    <h4>変化</h4><p>${escapeHtml(r.change || "-")}</p>
    <h4>確認質問</h4><p>${escapeHtml(r.question || "-")}</p>
    <h4>提案</h4><p>${proposalPrefix}${escapeHtml(r.proposal || "-")}</p>
    <h4>根拠事実</h4><ul>${facts}</ul>
    ${r.warnings && r.warnings.length ? `<h4 class="warn">警告</h4><ul class="warn">${warnings}</ul>` : ""}
    <p>信頼度: ${escapeHtml(confidenceLabel || "-")}</p>
  `;
}

/** Driver mode is deliberately terse (it's rendered as a huge-type HUD on the phone), so the
 * viewer shows it larger than the other modes rather than as a dense block. */
function renderDriver(r) {
  const urgencyLabel = { low: "低", medium: "中", high: "高" }[r.urgency] || r.urgency || "-";
  const watch = r.watch && String(r.watch).trim()
    ? `<p class="driver-watch">⚠ ${escapeHtml(r.watch)}</p>`
    : "";
  return `
    <p class="driver-headline">${escapeHtml(r.headline || "-")}</p>
    <p class="driver-action">▶ ${escapeHtml(r.action || "-")}</p>
    ${watch}
    <p class="driver-urgency urgency-${escapeHtml(r.urgency || "low")}">緊急度: ${escapeHtml(urgencyLabel)}</p>
  `;
}

// ── Driver HUD ───────────────────────────────────────────────────────────────
// Full-screen, huge-type view of just the newest driver-mode result, for the person
// actually driving/working (they can only glance for a second). Toggled from the header,
// or opened directly with `&hud=1` so it can be bookmarked on the driver's phone.
const driverHud = document.getElementById("driverHud");
const hudUrgency = document.getElementById("hudUrgency");
const hudHeadline = document.getElementById("hudHeadline");
const hudAction = document.getElementById("hudAction");
const hudWatch = document.getElementById("hudWatch");
const hudMeta = document.getElementById("hudMeta");
const hudForecast = document.getElementById("hudForecast");
const hudToggle = document.getElementById("hudToggle");
const hudExit = document.getElementById("hudExit");

let hudVisible = new URLSearchParams(location.search).get("hud") === "1";
let hudWeather = null;
let hudSnapshot = null;
let hudWeatherSessionId = null;
let hudWeatherFetchedAt = 0;
let hudWeatherInFlight = false;
let lastHudResult = null;
const HUD_WEATHER_REFRESH_MS = 60_000;
// A day-ahead forecast is useful in a planning screen, but not as a glanceable driver cue.
const HUD_FORECAST_MAX_ETA_MINUTES = 180;

function setHudVisible(visible) {
  hudVisible = visible;
  driverHud.hidden = !visible;
  // The HUD is position:fixed, but the page behind it still scrolls, which lets a stray swipe
  // drag the underlying viewer around under the overlay. Lock the body while it's up.
  document.body.classList.toggle("hud-open", visible);
  hudToggle.setAttribute("aria-expanded", String(visible));
  if (visible) {
    refreshAnalyses();
    refreshHudWeather(true);
  }
}

hudToggle.addEventListener("click", () => {
  const targetSession = requestedSession || "latest";
  location.assign(`/driver.html?session=${encodeURIComponent(targetSession)}`);
});
hudExit.addEventListener("click", () => setHudVisible(false));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && hudVisible) setHudVisible(false);
});
if (hudVisible) setHudVisible(true);

/** Shrinks the HUD text until it fits the viewport — the model's 24-char limit plus a small
 * screen can still overflow at the CSS clamp's largest size, and clipped text is worse than
 * slightly smaller text. */
function fitHudText() {
  const body = driverHud.querySelector(".hud-body");
  let scale = 1;
  driverHud.style.setProperty("--hud-scale", scale);
  let guard = 0;
  while (body.scrollHeight > body.clientHeight && scale > 0.5 && guard++ < 12) {
    scale -= 0.06;
    driverHud.style.setProperty("--hud-scale", scale.toFixed(2));
  }
}

/** "3分前" style age, because acting on a stale summary is the real hazard — the wall-clock
 * time would make the reader do that subtraction themselves at a glance. */
function relativeAge(iso) {
  const ageSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (ageSec < 15) return { text: "たった今", stale: false };
  if (ageSec < 60) return { text: `${ageSec}秒前`, stale: false };
  const min = Math.floor(ageSec / 60);
  if (min < 60) return { text: `${min}分前`, stale: min >= 3 };
  return { text: `${Math.floor(min / 60)}時間前`, stale: true };
}

function setHudMeta(iso, extra) {
  const { text, stale } = relativeAge(iso);
  // Prefix stale ages with a clock so the warning reads even before the color registers.
  const age = stale ? `⏱ ${text}` : text;
  hudMeta.textContent = extra ? `${age} · ${extra}` : age;
  hudMeta.classList.toggle("stale", stale);
}

function updateDriverHud(list) {
  if (!hudVisible) return;
  if (hudWeatherSessionId !== sessionId) {
    hudWeather = null;
    hudSnapshot = null;
    hudWeatherSessionId = sessionId;
    hudWeatherFetchedAt = 0;
  }
  if (!hudWeatherInFlight && Date.now() - hudWeatherFetchedAt >= HUD_WEATHER_REFRESH_MS) {
    refreshHudWeather();
  }
  const driverEntries = list.filter((a) => a.mode === "driver");
  const latest = driverEntries[driverEntries.length - 1];
  const latestCompleted = [...driverEntries].reverse().find(
    (a) => a.status === "done" && a.result,
  );

  driverHud.classList.remove("urgency-medium", "urgency-high");
  hudMeta.classList.remove("stale");

  if (!latest) {
    lastHudResult = null;
    hudUrgency.textContent = "緊急度: 低";
    hudHeadline.textContent = "ドライバー解析待ち";
    hudAction.hidden = true;
    hudWatch.hidden = true;
    renderHudRainForecast({});
    hudMeta.textContent = "アプリで解析を実行すると表示されます（設定の「ドライバー要約も生成」がONのとき）";
    fitHudText();
    return;
  }

  if (latest.status === "queued" || latest.status === "running") {
    // Keep a completed brief on screen while its replacement is generated. A driver cannot act
    // on a spinner, but can still use the prior instruction if it is clearly marked as updating.
    if (latestCompleted) {
      renderDriverHudResult(latestCompleted, "新しい解析を更新中");
      return;
    }
    hudHeadline.textContent = "解析中…";
    lastHudResult = null;
    hudAction.hidden = true;
    hudWatch.hidden = true;
    renderHudRainForecast({});
    setHudMeta(latest.created_at);
    fitHudText();
    return;
  }
  if (latest.status === "error") {
    lastHudResult = null;
    hudHeadline.textContent = "解析エラー";
    hudAction.hidden = true;
    hudWatch.hidden = true;
    renderHudRainForecast({});
    setHudMeta(latest.created_at, latest.error || "");
    fitHudText();
    return;
  }

  renderDriverHudResult(latest);
}

function renderDriverHudResult(entry, extraMeta = "") {
  const r = entry.result || {};
  lastHudResult = r;
  const urgencyLabel = { low: "低", medium: "中", high: "高" }[r.urgency] || "低";
  hudUrgency.textContent = `緊急度: ${urgencyLabel}`;
  hudHeadline.textContent = r.headline || "-";
  hudAction.textContent = `▶ ${r.action || "-"}`;
  hudAction.hidden = false;
  if (r.watch && String(r.watch).trim()) {
    hudWatch.textContent = `⚠ ${r.watch}`;
    hudWatch.hidden = false;
  } else {
    hudWatch.hidden = true;
  }
  if (r.urgency === "medium") driverHud.classList.add("urgency-medium");
  if (r.urgency === "high") driverHud.classList.add("urgency-high");
  renderHudRainForecast(r);
  setHudMeta(entry.created_at, extraMeta);
  fitHudText();
}

function renderHudRainForecast(result) {
  const etaMinutes = Number(result.rainEtaMinutes ?? hudWeather?.rainForecast?.etaMinutes);
  const probability = Number(result.rainProbability ?? hudWeather?.rainForecast?.probability);
  if (Number.isFinite(etaMinutes) && etaMinutes <= HUD_FORECAST_MAX_ETA_MINUTES && Number.isFinite(probability)) {
    const when = etaMinutes <= 5 ? "まもなく" : `${etaMinutes}分後`;
    renderHudWeatherLine(`${when} ☔️`);
    hudForecast.hidden = false;
    return;
  }
  const weatherValue = result.forecastWeather ?? hudWeather?.weatherForecast?.weather;
  const weather = typeof weatherValue === "string" ? weatherValue.trim() : "";
  const forecastEta = Number(result.forecastEtaMinutes ?? hudWeather?.weatherForecast?.etaMinutes);
  if (!weather || !Number.isFinite(forecastEta) || forecastEta > HUD_FORECAST_MAX_ETA_MINUTES) {
    renderHudCurrentWeather();
    return;
  }
  const when = forecastEta <= 5 ? "まもなく" : `${forecastEta}分後`;
  const icon = weather.includes("晴") ? "☀️" : weather.includes("雪") ? "❄️" : "☁️";
  renderHudWeatherLine(`${when} ${icon}`);
}

function renderHudCurrentWeather() {
  renderHudWeatherLine("");
}

function renderHudWeatherLine(prefix) {
  const details = [];
  if (hudSnapshot?.isRaining === true) details.push("☔️");
  if (hudSnapshot?.isRaining === false) details.push("☀️");
  if (typeof hudSnapshot?.temperatureC === "number") details.push(`${hudSnapshot.temperatureC.toFixed(0)}°`);
  if (typeof hudSnapshot?.humidityPercent === "number") details.push(`湿度${hudSnapshot.humidityPercent.toFixed(0)}%`);
  if (typeof hudSnapshot?.windSpeedMs === "number") details.push(`風${hudSnapshot.windSpeedMs.toFixed(1)}m/s`);
  if (!prefix && details.length === 0) {
    hudForecast.hidden = true;
    return;
  }
  hudForecast.textContent = [prefix, details.join("  ")].filter(Boolean).join("  ·  ");
  hudForecast.hidden = false;
}

async function refreshHudWeather(force = false) {
  if (!hudVisible || !sessionId || hudWeatherInFlight) return;
  if (!force && Date.now() - hudWeatherFetchedAt < HUD_WEATHER_REFRESH_MS) return;
  const requestedSessionId = sessionId;
  hudWeatherInFlight = true;
  try {
    const response = await api(`/api/sessions/${requestedSessionId}/weather`);
    if (sessionId !== requestedSessionId) return;
    hudWeather = response.weather || null;
    hudSnapshot = response.snapshot || null;
    hudWeatherSessionId = requestedSessionId;
    hudWeatherFetchedAt = Date.now();
    renderHudRainForecast(lastHudResult || {});
    fitHudText();
  } catch (err) {
    console.warn("weather refresh failed", err);
    // Retry on the next HUD poll; do not erase a still-useful prior forecast after a transient failure.
  } finally {
    hudWeatherInFlight = false;
  }
}

// ── View tabs (ライブ / ルート・時間) ───────────────────────────────────────
const tabLive = document.getElementById("tabLive");
const tabRoute = document.getElementById("tabRoute");
const routeSection = document.getElementById("routeSection");

function setActiveTab(tab) {
  const isRoute = tab === "route";
  routeSection.hidden = !isRoute;
  viewerSection.hidden = isRoute;
  tabLive.classList.toggle("active", !isRoute);
  tabRoute.classList.toggle("active", isRoute);
  tabLive.setAttribute("aria-selected", String(!isRoute));
  tabRoute.setAttribute("aria-selected", String(isRoute));
  if (isRoute) startRouteView();
  else stopRouteView();
}
tabLive.addEventListener("click", () => setActiveTab("live"));
tabRoute.addEventListener("click", () => setActiveTab("route"));

// ── Route / time view ───────────────────────────────────────────────────────
const mapEl = document.getElementById("map");
const routeSlider = document.getElementById("routeSlider");
const routePlayBtn = document.getElementById("routePlay");
const routeSpeedSelect = document.getElementById("routeSpeed");
const routeTimeLabel = document.getElementById("routeTimeLabel");
const routeHistoryEl = document.getElementById("routeHistory");
const routeWeatherEl = document.getElementById("routeWeather");

const ROUTE_TRACK_MAX_DRAW = 5000;
// A route-history row is a meaningful movement record, not a wall-clock sample. This is well
// above ordinary GPS drift while producing useful checkpoints while driving.
const ROUTE_HISTORY_DISTANCE_METERS = 250;
const ROUTE_WEATHER_SNAPSHOT_REFRESH_MS = 60_000;
// Snapshots are made once per device minute. A route checkpoint can fall between them, but a
// farther observation would be misleading, so do not attach one more than 90 seconds away.
const ROUTE_WEATHER_SNAPSHOT_MATCH_MS = 90_000;

let map = null;
// True once the MapLibre style has finished loading and sources/layers below exist. Anything
// that touches those sources/layers before then must be deferred (see the `styleLoaded` guards
// below) — adding them too early is silently dropped instead of erroring.
let styleLoaded = false;
let routeMarker = null;
if (typeof maplibregl !== "undefined" && mapEl) {
  try {
    // NOTE: MapLibre takes [lng, lat], unlike Leaflet's [lat, lng] — every coordinate pair below
    // is deliberately reversed from the old Leaflet code.
    map = new maplibregl.Map({
      container: mapEl,
      style: "https://tiles.openfreemap.org/styles/liberty",
      // Same Tokyo/zoom 5 fallback as before: a session with zero location points never calls
      // fitBounds (see onRouteDataChanged), so the map needs a sane initial view rather than
      // sitting on an undefined one.
      center: [139.767125, 35.681236],
      zoom: 5,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    // The OpenFreeMap style already carries the full required attribution
    // ("© OpenMapTiles © OpenStreetMap | OpenFreeMap © OpenMapTiles Data from OpenStreetMap");
    // adding it again as customAttribution duplicated it and ate three lines of a small map.
    // `compact` collapses it behind an (i) button, expandable on tap.
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    map.on("load", () => {
      map.addSource("fullTrack", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });
      map.addSource("highlightTrack", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });
      map.addLayer({ id: "fullTrack", type: "line", source: "fullTrack", paint: { "line-color": "#c7c7cc", "line-width": 3 } });
      map.addLayer({ id: "highlightTrack", type: "line", source: "highlightTrack", paint: { "line-color": "#ff9500", "line-width": 3 } });
      styleLoaded = true;
      // Data may have arrived (and been dropped) while the style was still loading — repaint now.
      if (routeLoc.length > 0) {
        onRouteDataChanged();
      }
    });
  } catch (err) {
    console.error(err);
    map = null;
  }
}

let routeLoc = []; // all locations for the session, id-ascending
let routeLastId = 0;
let routePollTimer = null;
let routeLoaded = false;
let routeLoading = false;
let routeWeatherFetchedAt = 0;
let routeWeatherSessionId = null;
let routeWeatherSnapshots = [];
let routeWeatherSnapshotsFetchedAt = 0;
let routeWeatherSnapshotsSessionId = null;
let routeWeatherSnapshotsInFlight = false;

function resetRouteSessionData() {
  routeLoc = [];
  routeLastId = 0;
  routeLoaded = false;
  routeWeatherFetchedAt = 0;
  routeWeatherSessionId = null;
  routeWeatherSnapshots = [];
  routeWeatherSnapshotsFetchedAt = 0;
  routeWeatherSnapshotsSessionId = null;
  routeSlider.value = "0";
  renderRouteHistory();
}

async function loadRouteHistoryFull() {
  if (!sessionId || routeLoading) return;
  routeLoading = true;
  try {
    let after = 0;
    for (;;) {
      const data = await api(`/api/sessions/${sessionId}/locations?after=${after}&limit=500`);
      const locs = data.locations || [];
      if (locs.length === 0) break;
      routeLoc.push(...locs);
      after = locs[locs.length - 1].id;
      routeLastId = after;
      if (locs.length < 500) break;
    }
  } catch (err) {
    console.error(err);
  } finally {
    routeLoading = false;
    routeLoaded = true;
    onRouteDataChanged();
  }
}

async function pollRouteHistory() {
  if (!sessionId) return;
  try {
    const data = await api(`/api/sessions/${sessionId}/locations?after=${routeLastId}&limit=500`);
    const locs = data.locations || [];
    if (locs.length > 0) {
      routeLoc.push(...locs);
      routeLastId = locs[locs.length - 1].id;
      onRouteDataChanged();
    }
  } catch (err) {
    console.error(err);
  }
  if (Date.now() - routeWeatherFetchedAt >= 60_000) refreshRouteWeather();
  if (Date.now() - routeWeatherSnapshotsFetchedAt >= ROUTE_WEATHER_SNAPSHOT_REFRESH_MS) {
    refreshRouteWeatherSnapshots();
  }
}

function startRouteView() {
  if (map) setTimeout(() => map.resize(), 0);
  if (!routeLoaded) loadRouteHistoryFull();
  if (routePollTimer === null) {
    routePollTimer = setInterval(pollRouteHistory, 2000);
  }
  refreshRouteWeather(true);
  refreshRouteWeatherSnapshots(true);
}

function stopRouteView() {
  stopRoutePlayback();
  if (routePollTimer !== null) {
    clearInterval(routePollTimer);
    routePollTimer = null;
  }
}

async function refreshRouteWeather(force = false) {
  if (!sessionId || !routeWeatherEl) return;
  if (!force && Date.now() - routeWeatherFetchedAt < 60_000) return;
  const requestedSessionId = sessionId;
  try {
    const response = await api(`/api/sessions/${requestedSessionId}/weather`);
    if (sessionId !== requestedSessionId) return;
    routeWeatherSessionId = requestedSessionId;
    routeWeatherFetchedAt = Date.now();
    renderRouteWeather(response.snapshot || null);
  } catch (err) {
    console.warn("route weather refresh failed", err);
    routeWeatherEl.textContent = "天気の取得に失敗しました";
  }
}

function renderRouteWeather(snapshot) {
  if (!snapshot) {
    routeWeatherEl.textContent = "現在地点の天気を記録待ち";
    return;
  }
  const formatTime = (value) => {
    if (!value || !Number.isFinite(new Date(value).getTime())) return "時刻なし";
    return new Date(value).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const rain = snapshot.isRaining === true ? "☔ 雨" : snapshot.isRaining === false ? "☀️ 降水なし" : "—";
  const amedasSource = snapshot.amedasStationId
    ? `AMeDAS ${snapshot.amedasStationId}${typeof snapshot.amedasStationDistanceKm === "number" ? ` · ${snapshot.amedasStationDistanceKm.toFixed(1)}km` : ""}`
    : "AMeDAS 未取得";
  const rainSource = snapshot.rainSourceObservedAt
    ? `解析時刻 ${formatTime(snapshot.rainSourceObservedAt)} 時点`
    : "JMAナウキャスト · 未取得";
  const amedasObserved = snapshot.amedasObservedAt
    ? `観測時刻 ${formatTime(snapshot.amedasObservedAt)} 時点`
    : amedasSource;
  const value = (number, suffix, digits = 1) => typeof number === "number" ? `${number.toFixed(digits)}${suffix}` : "—";
  const detail = (label, valueText, source) => `<div class="route-weather-item">
    <span>${escapeHtml(label)}</span><strong>${escapeHtml(valueText)}</strong><small>${escapeHtml(source)}</small>
  </div>`;
  const recordedAt = formatTime(snapshot.recordedAt);
  const coordinates = `${Number(snapshot.latitude).toFixed(5)}, ${Number(snapshot.longitude).toFixed(5)}`;
  routeWeatherEl.innerHTML = `
    <div class="route-weather-heading">現在地点の天気 <small>位置情報の記録 ${escapeHtml(recordedAt)}</small></div>
    <div class="route-weather-grid">
      ${detail("降水", rain, rainSource)}
      ${detail("気温", value(snapshot.temperatureC, "℃"), amedasObserved)}
      ${detail("湿度", value(snapshot.humidityPercent, "%", 0), amedasObserved)}
      ${detail("風速", value(snapshot.windSpeedMs, "m/s"), amedasObserved)}
    </div>
    <p class="route-weather-location">${escapeHtml(amedasSource)} · 記録地点 ${escapeHtml(coordinates)}</p>
  `;
}

async function refreshRouteWeatherSnapshots(force = false) {
  if (!sessionId || routeWeatherSnapshotsInFlight) return;
  if (!force && Date.now() - routeWeatherSnapshotsFetchedAt < ROUTE_WEATHER_SNAPSHOT_REFRESH_MS) return;
  const requestedSessionId = sessionId;
  routeWeatherSnapshotsInFlight = true;
  try {
    const response = await api(`/api/sessions/${requestedSessionId}/weather-snapshots`);
    if (sessionId !== requestedSessionId) return;
    routeWeatherSnapshots = response.snapshots || [];
    routeWeatherSnapshotsSessionId = requestedSessionId;
    routeWeatherSnapshotsFetchedAt = Date.now();
    renderRouteHistory();
  } catch (err) {
    console.warn("route weather snapshot refresh failed", err);
  } finally {
    routeWeatherSnapshotsInFlight = false;
  }
}

function decimate(arr, maxLen) {
  if (arr.length <= maxLen) return arr;
  const step = arr.length / maxLen;
  const out = [];
  for (let i = 0; i < maxLen; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

let routeSliderDragging = false;

function onRouteDataChanged() {
  if (routeLoc.length === 0) return;

  if (map && styleLoaded) {
    const drawn = decimate(routeLoc, ROUTE_TRACK_MAX_DRAW);
    // [p.lng, p.lat]: MapLibre coordinate order, reversed from Leaflet's [lat, lng].
    const coords = drawn.map((p) => [p.lng, p.lat]);
    map.getSource("fullTrack").setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
    if (!routeMarker && coords.length > 0) {
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0])
      );
      map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
    }
  }

  const minT = new Date(routeLoc[0].recorded_at).getTime() / 1000;
  const maxT = new Date(routeLoc[routeLoc.length - 1].recorded_at).getTime() / 1000;
  routeSlider.min = String(Math.floor(minT));
  routeSlider.max = String(Math.ceil(maxT));
  if (!routeSliderDragging && (routeSlider.value === "0" || Number(routeSlider.value) < minT)) {
    routeSlider.value = routeSlider.max; // follow the newest point by default
  }
  seekRouteToSliderValue();
  renderRouteHistory();
}

function findNearestLocationIndex(epochSec) {
  // routeLoc is id-ascending == time-ascending; binary search for closest recorded_at.
  let lo = 0;
  let hi = routeLoc.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const t = new Date(routeLoc[mid].recorded_at).getTime() / 1000;
    if (t < epochSec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function seekRouteToSliderValue() {
  if (routeLoc.length === 0) return;
  const epochSec = Number(routeSlider.value);
  const idx = findNearestLocationIndex(epochSec);
  const loc = routeLoc[idx];
  routeTimeLabel.textContent = new Date(loc.recorded_at).toLocaleString("ja-JP");

  if (map && styleLoaded) {
    // [lng, lat]: MapLibre coordinate order, reversed from Leaflet's [lat, lng].
    const lnglat = [loc.lng, loc.lat];
    const upTo = decimate(routeLoc.slice(0, idx + 1), ROUTE_TRACK_MAX_DRAW);
    map.getSource("highlightTrack").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: upTo.map((p) => [p.lng, p.lat]) },
    });
    if (!routeMarker) {
      const el = document.createElement("div");
      el.className = "route-marker";
      routeMarker = new maplibregl.Marker({ element: el }).setLngLat(lnglat).addTo(map);
    } else {
      routeMarker.setLngLat(lnglat);
    }
  }
  highlightActiveHistoryRow(loc.recorded_at);
}

routeSlider.addEventListener("input", () => {
  routeSliderDragging = true;
  seekRouteToSliderValue();
});
routeSlider.addEventListener("change", () => {
  routeSliderDragging = false;
});

// ── Replay playback ─────────────────────────────────────────────────────────
let routePlaybackTimer = null;

function stopRoutePlayback() {
  if (routePlaybackTimer !== null) {
    clearInterval(routePlaybackTimer);
    routePlaybackTimer = null;
    routePlayBtn.textContent = "▶ 再生";
  }
}

function startRoutePlayback() {
  if (routeLoc.length === 0) return;
  const speed = Number(routeSpeedSelect.value) || 1;
  const max = Number(routeSlider.max);
  routePlayBtn.textContent = "⏸ 停止";
  routePlaybackTimer = setInterval(() => {
    const next = Number(routeSlider.value) + speed;
    if (next >= max) {
      routeSlider.value = String(max);
      seekRouteToSliderValue();
      stopRoutePlayback();
      return;
    }
    routeSlider.value = String(next);
    seekRouteToSliderValue();
  }, 1000);
}

routePlayBtn.addEventListener("click", () => {
  if (routePlaybackTimer !== null) stopRoutePlayback();
  else startRoutePlayback();
});

// ── Movement history ────────────────────────────────────────────────────────
function locationDistanceMeters(a, b) {
  const radians = Math.PI / 180;
  const lat1 = a.lat * radians;
  const lat2 = b.lat * radians;
  const dLat = (b.lat - a.lat) * radians;
  const dLng = (b.lng - a.lng) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function routeHistoryEntries() {
  if (routeLoc.length === 0) return [];
  const entries = [{ location: routeLoc[0], points: [routeLoc[0]] }];
  let lastRecorded = routeLoc[0];
  let segmentPoints = [routeLoc[0]];

  for (const loc of routeLoc.slice(1)) {
    segmentPoints.push(loc);
    if (locationDistanceMeters(lastRecorded, loc) < ROUTE_HISTORY_DISTANCE_METERS) continue;
    entries[entries.length - 1].points = segmentPoints;
    entries.push({ location: loc, points: [loc] });
    lastRecorded = loc;
    segmentPoints = [loc];
  }
  return entries;
}

function weatherSnapshotNearRouteTime(recordedAt) {
  if (routeWeatherSnapshotsSessionId !== sessionId || routeWeatherSnapshots.length === 0) return null;
  const target = new Date(recordedAt).getTime();
  if (!Number.isFinite(target)) return null;
  let low = 0;
  let high = routeWeatherSnapshots.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (new Date(routeWeatherSnapshots[middle].recordedAt).getTime() < target) low = middle + 1;
    else high = middle;
  }
  const candidates = [routeWeatherSnapshots[low - 1], routeWeatherSnapshots[low]].filter(Boolean);
  let closest = null;
  let closestDistance = Infinity;
  for (const snapshot of candidates) {
    const distance = Math.abs(new Date(snapshot.recordedAt).getTime() - target);
    if (distance < closestDistance) {
      closest = snapshot;
      closestDistance = distance;
    }
  }
  return closestDistance <= ROUTE_WEATHER_SNAPSHOT_MATCH_MS ? closest : null;
}

function routeHistoryWeatherText(snapshot) {
  if (!snapshot) return "—";
  const values = [];
  if (snapshot.isRaining === true) values.push("☔");
  if (snapshot.isRaining === false) values.push("☀️");
  if (typeof snapshot.temperatureC === "number") values.push(`${snapshot.temperatureC.toFixed(0)}°`);
  if (typeof snapshot.humidityPercent === "number") values.push(`${snapshot.humidityPercent.toFixed(0)}%`);
  if (typeof snapshot.windSpeedMs === "number") values.push(`${snapshot.windSpeedMs.toFixed(1)}m/s`);
  return values.length > 0 ? values.join(" ") : "—";
}

function renderRouteHistory() {
  const entries = routeHistoryEntries();

  const rows = entries
    .map((entry) => {
      const location = entry.location;
      const speeds = entry.points
        .map((p) => p.speed_mps)
        .filter((s) => typeof s === "number" && !Number.isNaN(s));
      const avgSpeedKmh =
        speeds.length > 0 ? ((speeds.reduce((a, c) => a + c, 0) / speeds.length) * 3.6).toFixed(1) : "-";
      const time = new Date(location.recorded_at).toLocaleTimeString("ja-JP");
      const coord = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
      const weather = routeHistoryWeatherText(weatherSnapshotNearRouteTime(location.recorded_at));
      return `<tr class="route-history-row" data-recorded-at="${escapeHtml(location.recorded_at)}">
        <td>${escapeHtml(time)}</td>
        <td>${escapeHtml(coord)}</td>
        <td>${escapeHtml(avgSpeedKmh)} km/h</td>
        <td class="route-history-weather">${escapeHtml(weather)}</td>
        <td>${entry.points.length}</td>
      </tr>`;
    })
    .join("");

  routeHistoryEl.innerHTML = `
    <table>
      <thead><tr><th>開始時刻</th><th>座標</th><th>平均速度</th><th>天気</th><th>点数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  routeHistoryEl.querySelectorAll(".route-history-row").forEach((row) => {
    row.addEventListener("click", () => {
      const recordedAt = row.dataset.recordedAt;
      routeSlider.value = String(Math.floor(new Date(recordedAt).getTime() / 1000));
      seekRouteToSliderValue();
    });
  });
}

function highlightActiveHistoryRow(recordedAt) {
  const targetTime = new Date(recordedAt).getTime();
  const rows = [...routeHistoryEl.querySelectorAll(".route-history-row")];
  let active = rows[0] ?? null;
  for (const row of rows) {
    if (new Date(row.dataset.recordedAt).getTime() <= targetTime) active = row;
    else break;
  }
  rows.forEach((row) => row.classList.toggle("active", row === active));
}

// ── Named route (国土地理院リバースジオコード) ─────────────────────────────
// AIは使わず、GPS軌跡を市区町村名/地名の通過地点リストに変換して表示する。外部ジオコードAPIを
// 叩きすぎないよう、2秒ポーリングの対象にはせず「ルート更新」ボタン押下時にのみ取得する。
const routeNamesRefreshBtn = document.getElementById("routeNamesRefresh");
const routeNamesStatusEl = document.getElementById("routeNamesStatus");
const routeNamesListEl = document.getElementById("routeNamesList");

async function refreshRouteNames() {
  if (!sessionId) return;
  routeNamesStatusEl.textContent = "取得中…";
  routeNamesRefreshBtn.disabled = true;
  try {
    const data = await api(`/api/sessions/${sessionId}/route`);
    renderRouteNames(data.route || []);
    routeNamesStatusEl.textContent = "";
  } catch (err) {
    console.error(err);
    routeNamesStatusEl.textContent = "取得に失敗しました";
  } finally {
    routeNamesRefreshBtn.disabled = false;
  }
}

function renderRouteNames(route) {
  if (route.length === 0) {
    routeNamesListEl.innerHTML = `<p class="route-names-empty">位置情報がまだありません</p>`;
    return;
  }
  const rows = route
    .map((p) => {
      const time = new Date(p.enteredAt).toLocaleString("ja-JP");
      return `<div class="route-names-row">
        <span class="route-names-time">${escapeHtml(time)}</span>
        <span class="route-names-name">${escapeHtml(p.name)}</span>
      </div>`;
    })
    .join("");
  routeNamesListEl.innerHTML = rows;
}

routeNamesRefreshBtn.addEventListener("click", refreshRouteNames);
renderRouteNames([]);

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
