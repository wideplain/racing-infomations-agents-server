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
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const requestedSession = new URLSearchParams(location.search).get("session");
const noSessionSection = document.getElementById("noSessionSection");
const viewerSection = document.getElementById("viewerSection");
const segmentsEl = document.getElementById("segments");
const analysesEl = document.getElementById("analyses");
const statusSessionEl = document.getElementById("statusSession");
const statusConnectionEl = document.getElementById("statusConnection");
const statusSegCountEl = document.getElementById("statusSegCount");
const statusAnalysisCountEl = document.getElementById("statusAnalysisCount");
const statusLastUpdateEl = document.getElementById("statusLastUpdate");
const statusLocationEl = document.getElementById("statusLocation");

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
      maybeStartLocationSend();
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
segmentsEl.addEventListener("scroll", () => {
  segmentsAtBottom = segmentsEl.scrollHeight - segmentsEl.scrollTop - segmentsEl.clientHeight < 40;
});

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
  segmentsEl.scrollTop = segmentsAtBottom ? segmentsEl.scrollHeight : prevScrollTop;
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
const hudToggle = document.getElementById("hudToggle");
const hudExit = document.getElementById("hudExit");

let hudVisible =
  new URLSearchParams(location.search).get("hud") === "1" ||
  localStorage.getItem("driverHud") === "1";

function setHudVisible(visible) {
  hudVisible = visible;
  driverHud.hidden = !visible;
  // The HUD is position:fixed, but the page behind it still scrolls, which lets a stray swipe
  // drag the underlying viewer around under the overlay. Lock the body while it's up.
  document.body.classList.toggle("hud-open", visible);
  localStorage.setItem("driverHud", visible ? "1" : "0");
  if (visible) refreshAnalyses();
}

hudToggle.addEventListener("click", () => setHudVisible(true));
hudExit.addEventListener("click", () => setHudVisible(false));
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
  const driverEntries = list.filter((a) => a.mode === "driver");
  const latest = driverEntries[driverEntries.length - 1];

  driverHud.classList.remove("urgency-medium", "urgency-high");
  hudMeta.classList.remove("stale");

  if (!latest) {
    hudUrgency.textContent = "緊急度: 低";
    hudHeadline.textContent = "ドライバー解析待ち";
    hudAction.hidden = true;
    hudWatch.hidden = true;
    hudMeta.textContent = "アプリで解析を実行すると表示されます（設定の「ドライバー要約も生成」がONのとき）";
    fitHudText();
    return;
  }

  if (latest.status === "queued" || latest.status === "running") {
    hudHeadline.textContent = "解析中…";
    hudAction.hidden = true;
    hudWatch.hidden = true;
    setHudMeta(latest.created_at);
    fitHudText();
    return;
  }
  if (latest.status === "error") {
    hudHeadline.textContent = "解析エラー";
    hudAction.hidden = true;
    hudWatch.hidden = true;
    setHudMeta(latest.created_at, latest.error || "");
    fitHudText();
    return;
  }

  const r = latest.result || {};
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
  setHudMeta(latest.created_at);
  fitHudText();
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

const ROUTE_TRACK_MAX_DRAW = 5000;
const ROUTE_BUCKET_MS = 5 * 60 * 1000;

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
}

function startRouteView() {
  if (map) setTimeout(() => map.resize(), 0);
  if (!routeLoaded) loadRouteHistoryFull();
  if (routePollTimer === null) {
    routePollTimer = setInterval(pollRouteHistory, 2000);
  }
}

function stopRouteView() {
  stopRoutePlayback();
  if (routePollTimer !== null) {
    clearInterval(routePollTimer);
    routePollTimer = null;
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

// ── Interval history (5-minute buckets) ─────────────────────────────────────
function renderRouteHistory() {
  const buckets = [];
  let current = null;
  for (const loc of routeLoc) {
    const t = new Date(loc.recorded_at).getTime();
    const bucketStart = Math.floor(t / ROUTE_BUCKET_MS) * ROUTE_BUCKET_MS;
    if (!current || current.bucketStart !== bucketStart) {
      current = { bucketStart, points: [] };
      buckets.push(current);
    }
    current.points.push(loc);
  }

  const rows = buckets
    .map((b) => {
      const first = b.points[0];
      const speeds = b.points
        .map((p) => p.speed_mps)
        .filter((s) => typeof s === "number" && !Number.isNaN(s));
      const avgSpeedKmh =
        speeds.length > 0 ? ((speeds.reduce((a, c) => a + c, 0) / speeds.length) * 3.6).toFixed(1) : "-";
      const time = new Date(first.recorded_at).toLocaleTimeString("ja-JP");
      const coord = `${first.lat.toFixed(5)}, ${first.lng.toFixed(5)}`;
      return `<tr class="route-history-row" data-recorded-at="${escapeHtml(first.recorded_at)}">
        <td>${escapeHtml(time)}</td>
        <td>${escapeHtml(coord)}</td>
        <td>${escapeHtml(avgSpeedKmh)} km/h</td>
        <td>${b.points.length}</td>
      </tr>`;
    })
    .join("");

  routeHistoryEl.innerHTML = `
    <table>
      <thead><tr><th>開始時刻</th><th>座標</th><th>平均速度</th><th>点数</th></tr></thead>
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
  const t = new Date(recordedAt).getTime();
  const bucketStart = Math.floor(t / ROUTE_BUCKET_MS) * ROUTE_BUCKET_MS;
  routeHistoryEl.querySelectorAll(".route-history-row").forEach((row) => {
    const rowBucket = Math.floor(new Date(row.dataset.recordedAt).getTime() / ROUTE_BUCKET_MS) * ROUTE_BUCKET_MS;
    row.classList.toggle("active", rowBucket === bucketStart);
  });
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

// ── Send this device's location ────────────────────────────────────────────
// Auto-starts once a session id is known (either the explicit ?session= or the id
// syncLatestSession() resolves while following "latest"). Points are buffered and flushed
// in small batches so a flaky connection doesn't mean one fetch per GPS fix.
const LOCATION_SEND_BUFFER_MAX = 10;
const LOCATION_SEND_BATCH_SIZE = 3;
const LOCATION_SEND_INTERVAL_MS = 3000;

let locationWatchId = null;
let locationSendBuffer = [];

// Maps the feature's existing long-form messages to a short label that fits the status bar.
const LOCATION_STATUS_LABELS = {
  "この環境では位置情報を利用できません（HTTPS接続が必要です）": "HTTPS必須",
  "この環境では位置情報を利用できません": "HTTPS必須",
  "位置送信中": "送信中",
  "位置情報の権限がありません": "権限なし",
  "位置情報を取得できません": "取得不可",
};

function setSendLocationStatus(text) {
  if (!statusLocationEl) return;
  statusLocationEl.hidden = false;
  statusLocationEl.textContent = LOCATION_STATUS_LABELS[text] || text;
  statusLocationEl.classList.toggle("status-error", text !== "位置送信中");
}

function locationSendPointFromPosition(position) {
  const c = position.coords;
  const point = {
    lat: c.latitude,
    lng: c.longitude,
    recordedAt: new Date(position.timestamp).toISOString(),
  };
  if (typeof c.accuracy === "number" && !Number.isNaN(c.accuracy)) point.accuracyM = c.accuracy;
  if (typeof c.speed === "number" && !Number.isNaN(c.speed)) point.speedMps = c.speed;
  if (typeof c.heading === "number" && !Number.isNaN(c.heading)) point.bearingDeg = c.heading;
  return point;
}

function flushLocationSendBuffer() {
  if (locationSendBuffer.length === 0) return;
  if (!sessionId) {
    locationSendBuffer = [];
    return;
  }
  const batch = locationSendBuffer;
  locationSendBuffer = [];
  api(`/api/sessions/${sessionId}/locations`, {
    method: "POST",
    body: JSON.stringify({ locations: batch }),
  }).catch((err) => {
    console.warn("location send failed, dropping batch", err);
  });
}

function pushLocationSendPoint(point) {
  locationSendBuffer.push(point);
  if (locationSendBuffer.length > LOCATION_SEND_BUFFER_MAX) locationSendBuffer.shift();
  if (locationSendBuffer.length >= LOCATION_SEND_BATCH_SIZE) flushLocationSendBuffer();
}

setInterval(() => {
  if (locationSendBuffer.length > 0) flushLocationSendBuffer();
}, LOCATION_SEND_INTERVAL_MS);

function startLocationWatch() {
  if (locationWatchId !== null) return; // already watching
  if (!window.isSecureContext) {
    setSendLocationStatus("この環境では位置情報を利用できません（HTTPS接続が必要です）");
    return;
  }
  if (!navigator.geolocation) {
    setSendLocationStatus("この環境では位置情報を利用できません");
    return;
  }
  locationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      setSendLocationStatus("位置送信中");
      pushLocationSendPoint(locationSendPointFromPosition(position));
    },
    (err) => {
      setSendLocationStatus(
        err.code === err.PERMISSION_DENIED
          ? "位置情報の権限がありません"
          : "位置情報を取得できません"
      );
    },
    { enableHighAccuracy: true, maximumAge: 0 }
  );
}

function stopLocationWatch() {
  if (locationWatchId === null) return;
  navigator.geolocation.clearWatch(locationWatchId);
  locationWatchId = null;
}

window.addEventListener("beforeunload", stopLocationWatch);

// Called once at load (covers an explicit ?session=) and again whenever syncLatestSession()
// resolves a session id while following "latest"; startLocationWatch() is a no-op once running.
function maybeStartLocationSend() {
  if (sessionId) startLocationWatch();
}
maybeStartLocationSend();

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
