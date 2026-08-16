// テキストテストモード: drive the whole pipeline from a browser with no phone involved — create a
// session, inject text as if the app had recognized it, run any analysis mode, watch the result.
// Rendering of analysis results deliberately mirrors viewer.js so both pages read the same.

const apiKeyInput = document.getElementById("apiKey");
apiKeyInput.value = localStorage.getItem("apiKey") || "";
apiKeyInput.addEventListener("input", () => {
  localStorage.setItem("apiKey", apiKeyInput.value);
});

const errorBanner = document.getElementById("errorBanner");

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}
function clearError() {
  errorBanner.hidden = true;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "X-Api-Key": apiKeyInput.value,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("APIキーが正しくありません。右上の API Key 欄を確認してください。");
    }
    throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Every handler routes failures to the one banner rather than alert()/console, so a mistyped
 * key or a stopped server is visible without opening devtools. */
async function guard(fn) {
  try {
    await fn();
    clearError();
  } catch (err) {
    showError(err.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(fromIso, toIso) {
  const ms = new Date(toIso || Date.now()).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}分`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

// ── Session list ─────────────────────────────────────────────────────────────
const sessionListSection = document.getElementById("sessionListSection");
const sessionDetailSection = document.getElementById("sessionDetailSection");
const sessionListEl = document.getElementById("sessionList");
const sessionListEmptyEl = document.getElementById("sessionListEmpty");
const sessionSearch = document.getElementById("sessionSearch");

let allSessions = [];
let listFilter = "all";

async function loadSessions() {
  allSessions = await api("/api/sessions");
  renderSessions();
}

/** Filtering is client-side: the list is small (one session per recording run) and keeping it
 * local means typing in the search box doesn't wait on the network. */
function renderSessions() {
  const query = sessionSearch.value.trim().toLowerCase();
  const visible = allSessions.filter((s) => {
    if (listFilter === "live" && s.ended_at) return false;
    if (listFilter === "ended" && !s.ended_at) return false;
    if (!query) return true;
    return `${s.title || ""} ${s.id}`.toLowerCase().includes(query);
  });

  sessionListEl.innerHTML = "";
  for (const s of visible) sessionListEl.appendChild(renderSessionCard(s));

  sessionListEmptyEl.hidden = visible.length > 0;
  sessionListEmptyEl.textContent = allSessions.length
    ? "条件に一致するセッションがありません。"
    : "セッションがまだありません。「＋ 新規セッション」で作成してください。";
}

function renderSessionCard(s) {
  const li = document.createElement("li");
  li.className = `session-card${s.ended_at ? "" : " is-live"}`;
  li.tabIndex = 0;
  li.setAttribute("role", "button");

  const live = s.ended_at
    ? `<span class="badge ended">終了</span>`
    : `<span class="badge live">進行中</span>`;
  const lastActivity = s.last_segment_at
    ? `最終発話 ${formatDateTime(s.last_segment_at)}`
    : "発話なし";

  li.innerHTML = `
    <div class="session-name">${live}<span>${escapeHtml(s.title || "(無題)")}</span></div>
    <div class="session-stats">
      <span>開始 ${formatDateTime(s.started_at)}</span>
      <span>${formatDuration(s.started_at, s.ended_at)}</span>
      <span>発話 ${s.segment_count ?? 0}</span>
      <span>解析 ${s.analysis_count ?? 0}</span>
      <span>${lastActivity}</span>
    </div>
    <div class="session-id">${escapeHtml(s.id)}</div>
    <div class="session-links">
      <a class="mode-link" href="/viewer.html?session=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">👁 ビュワー</a>
      <a class="mode-link" href="/driver.html?session=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">🏎 ドライバー</a>
    </div>
  `;

  // The card itself opens the session; the links inside must not also trigger that.
  for (const link of li.querySelectorAll("a")) {
    link.addEventListener("click", (e) => e.stopPropagation());
  }
  li.addEventListener("click", () => guard(() => openSession(s.id)));
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      guard(() => openSession(s.id));
    }
  });
  return li;
}

sessionSearch.addEventListener("input", renderSessions);

for (const chip of document.querySelectorAll(".chip[data-filter]")) {
  chip.addEventListener("click", () => {
    listFilter = chip.dataset.filter;
    for (const other of document.querySelectorAll(".chip[data-filter]")) {
      other.classList.toggle("active", other === chip);
    }
    renderSessions();
  });
}

document.getElementById("refreshBtn").addEventListener("click", () => guard(loadSessions));

document.getElementById("newSessionBtn").addEventListener("click", () =>
  guard(async () => {
    const title = prompt("セッション名（任意）", "") ?? undefined;
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: title || undefined }),
    });
    await loadSessions();
    await openSession(session.id);
  })
);

// ── Session detail ───────────────────────────────────────────────────────────
const sessionTitleEl = document.getElementById("sessionTitle");
const sessionMetaEl = document.getElementById("sessionMeta");
const sessionIdLabel = document.getElementById("sessionIdLabel");
const segmentsEl = document.getElementById("segments");
const segmentCountEl = document.getElementById("segmentCount");
const segmentForm = document.getElementById("segmentForm");
const segmentText = document.getElementById("segmentText");
const analysesEl = document.getElementById("analyses");
const analyzeBtn = document.getElementById("analyzeBtn");
const analyzeStatus = document.getElementById("analyzeStatus");
const analyzeMode = document.getElementById("analyzeMode");
const analyzeInstruction = document.getElementById("analyzeInstruction");
const alsoDriver = document.getElementById("alsoDriver");
const endSessionBtn = document.getElementById("endSessionBtn");

let currentSessionId = null;
let clientSeqCounter = 0;
let pollTimer = null;

async function openSession(id) {
  currentSessionId = id;
  // Keep the URL pointing at what's on screen so a session can be linked/reloaded, matching how
  // viewer.html and driver.html are addressed.
  history.replaceState(null, "", `?session=${encodeURIComponent(id)}`);
  // Seeded from the clock so seqs never collide with what the phone already sent, and so a
  // page reload can't reuse a seq the server has stored (which would be silently dropped).
  clientSeqCounter = Date.now();
  sessionListSection.hidden = true;
  sessionDetailSection.hidden = false;
  analyzeStatus.textContent = "-";
  // The render guards below compare against the last painted signature; without clearing them,
  // switching to a session whose data happens to hash the same would leave the old DOM up.
  renderSegments.lastSignature = null;
  renderAnalyses.lastSignature = null;
  document.getElementById("openViewerLink").href = `/viewer.html?session=${encodeURIComponent(id)}`;
  document.getElementById("openDriverLink").href = `/driver.html?session=${encodeURIComponent(id)}`;
  await refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => guard(refresh), 2000);
}

function closeSession() {
  currentSessionId = null;
  clearInterval(pollTimer);
  history.replaceState(null, "", location.pathname);
  sessionDetailSection.hidden = true;
  sessionListSection.hidden = false;
  guard(loadSessions);
}

document.getElementById("backBtn").addEventListener("click", closeSession);

async function refresh() {
  if (!currentSessionId) return;
  const [detail, analyses] = await Promise.all([
    api(`/api/sessions/${currentSessionId}`),
    api(`/api/sessions/${currentSessionId}/analyses`),
  ]);
  renderDetailHeading(detail);
  renderSegments(detail.segments);
  renderAnalyses(analyses);
}

function renderDetailHeading(detail) {
  sessionTitleEl.textContent = detail.title || "(無題)";
  const state = detail.ended_at ? "終了" : "進行中";
  sessionMetaEl.textContent =
    `${state} ・ 開始 ${formatDateTime(detail.started_at)} ・ ` +
    formatDuration(detail.started_at, detail.ended_at);
  // Full id in its own element: it's what you paste into curl, but it's long enough to wrap the
  // heading onto a second line on a phone, so the CSS ellipsizes it there.
  sessionIdLabel.textContent = detail.id;
  sessionIdLabel.title = detail.id;
  endSessionBtn.disabled = Boolean(detail.ended_at);
}

function renderSegments(segments) {
  segmentCountEl.textContent = `${segments.length} 行`;
  // Only rebuild when something changed, so polling can't cancel a scroll gesture in progress.
  const signature = segments.map((s) => `${s.client_seq}:${s.excluded}:${s.text.length}`).join("|");
  if (signature === renderSegments.lastSignature) return;
  renderSegments.lastSignature = signature;

  const atBottom = segmentsEl.scrollHeight - segmentsEl.scrollTop - segmentsEl.clientHeight < 40;
  segmentsEl.innerHTML = segments
    .map(
      (seg) =>
        `<div class="segment-line${seg.excluded ? " excluded" : ""}">` +
        `<span class="segment-time">${new Date(seg.created_at).toLocaleTimeString("ja-JP")}</span>` +
        `${seg.excluded ? "🗄 " : ""}${escapeHtml(seg.text)}</div>`
    )
    .join("");
  if (atBottom) segmentsEl.scrollTop = segmentsEl.scrollHeight;
}

function renderAnalyses(list) {
  const signature = list.map((a) => `${a.id}:${a.status}`).join("|");
  if (signature === renderAnalyses.lastSignature) return;
  renderAnalyses.lastSignature = signature;

  // Newest first: on this page you run an analysis and want to see that one, not scroll for it.
  const ordered = [...list].reverse();
  analysesEl.innerHTML = ordered.length
    ? ordered.map(renderAnalysisEntry).join("")
    : `<p class="pane-note">まだ解析結果がありません。</p>`;

  const pending = list.filter((a) => a.status === "queued" || a.status === "running").length;
  const failed = list.filter((a) => a.status === "error").length;
  analyzeStatus.textContent = !list.length
    ? "-"
    : pending
      ? `解析中 ${pending} 件`
      : failed
        ? `完了（エラー ${failed} 件）`
        : `完了 ${list.length} 件`;
}

// ── Analysis rendering (same markup and labels as viewer.js) ─────────────────
function renderAnalysisEntry(a) {
  const time = new Date(a.created_at).toLocaleTimeString("ja-JP");
  const modeLabel =
    a.mode === "pitwall" ? "ピットウォール" : a.mode === "driver" ? "ドライバー" : "通常";
  const modeClass = a.mode === "pitwall" ? "pitwall" : a.mode === "driver" ? "driver" : "";

  let body;
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
  } else body = `<p>結果なし</p>`;

  return `<div class="analysis-entry">
    <span class="entry-time">${time}</span><span class="entry-mode ${modeClass}">${modeLabel}</span>
    ${body}
  </div>`;
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

// ── Text injection ───────────────────────────────────────────────────────────
segmentForm.addEventListener("submit", (e) => {
  e.preventDefault();
  guard(sendSegments);
});

// The textarea is multi-line so pasted dialogue can be sent at once; Enter alone therefore has
// to keep inserting newlines, and the modifier submits.
segmentText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    guard(sendSegments);
  }
});

async function sendSegments() {
  const raw = segmentText.value;
  if (!raw.trim() || !currentSessionId) return;
  // One line = one recognized utterance, matching what the phone posts.
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const segments = lines.map((text) => ({ clientSeq: ++clientSeqCounter, text, isFinal: true }));
  await api(`/api/sessions/${currentSessionId}/segments`, {
    method: "POST",
    body: JSON.stringify({ segments }),
  });
  segmentText.value = "";
  await refresh();
}

// ── Analyze ──────────────────────────────────────────────────────────────────
// The server ignores alsoDriver when the requested mode is already driver; grey it out so the
// checkbox never looks like it's doing something it isn't.
function syncAlsoDriver() {
  alsoDriver.disabled = analyzeMode.value === "driver";
}
analyzeMode.addEventListener("change", syncAlsoDriver);
syncAlsoDriver();

analyzeBtn.addEventListener("click", () =>
  guard(async () => {
    if (!currentSessionId) return;
    const instruction = analyzeInstruction.value.trim();
    analyzeStatus.textContent = "解析を投入中…";
    await api(`/api/sessions/${currentSessionId}/analyze`, {
      method: "POST",
      body: JSON.stringify({
        mode: analyzeMode.value,
        instruction: instruction || undefined,
        alsoDriver: alsoDriver.checked,
      }),
    });
    // The 2s poll already picks up queued → running → done, so there's no second polling loop.
    await refresh();
  })
);

endSessionBtn.addEventListener("click", () =>
  guard(async () => {
    if (!currentSessionId || !confirm("このセッションを終了しますか？")) return;
    await api(`/api/sessions/${currentSessionId}/end`, { method: "POST" });
    await refresh();
  })
);

// `?session=<id>` opens straight into that session's detail, so links from the other modes and a
// plain reload both land where you were.
guard(async () => {
  await loadSessions();
  const requested = new URLSearchParams(location.search).get("session");
  if (requested) await openSession(requested);
});
