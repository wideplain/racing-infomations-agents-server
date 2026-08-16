const apiKeyInput = document.getElementById("apiKey");
apiKeyInput.value = localStorage.getItem("apiKey") || "dev";
apiKeyInput.addEventListener("input", () => {
  localStorage.setItem("apiKey", apiKeyInput.value);
});

function apiHeaders(extra = {}) {
  return { "X-Api-Key": apiKeyInput.value, ...extra };
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: apiHeaders(opts.body ? { "Content-Type": "application/json" } : {}),
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("APIキーが正しくありません。上部の API Key 欄を確認してください。");
    }
    throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const sessionListSection = document.getElementById("sessionListSection");
const sessionDetailSection = document.getElementById("sessionDetailSection");
const sessionListEl = document.getElementById("sessionList");
const sessionTitleEl = document.getElementById("sessionTitle");
const segmentsEl = document.getElementById("segments");
const segmentForm = document.getElementById("segmentForm");
const segmentText = document.getElementById("segmentText");
const analyzeBtn = document.getElementById("analyzeBtn");
const analyzeStatus = document.getElementById("analyzeStatus");
const analysisResult = document.getElementById("analysisResult");

let currentSessionId = null;
let clientSeqCounter = 0;
let pollTimer = null;
let analyzePollTimer = null;

async function loadSessions() {
  const sessions = await api("/api/sessions");
  sessionListEl.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${s.title || "(無題)"} — ${new Date(s.started_at).toLocaleString("ja-JP")}`;
    label.addEventListener("click", () => openSession(s.id));
    li.appendChild(label);

    const viewerLink = document.createElement("a");
    viewerLink.className = "viewer-link";
    viewerLink.href = `/viewer.html?session=${s.id}`;
    viewerLink.target = "_blank";
    viewerLink.rel = "noopener";
    viewerLink.textContent = "👁 ビュワー";
    // Don't let the link click bubble up into li's "open session" click handler.
    viewerLink.addEventListener("click", (e) => e.stopPropagation());
    li.appendChild(viewerLink);

    sessionListEl.appendChild(li);
  }
}

document.getElementById("newSessionBtn").addEventListener("click", async () => {
  const title = prompt("セッション名（任意）", "") || undefined;
  try {
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    await loadSessions();
    openSession(session.id);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("backBtn").addEventListener("click", () => {
  currentSessionId = null;
  clearInterval(pollTimer);
  clearInterval(analyzePollTimer);
  sessionDetailSection.hidden = true;
  sessionListSection.hidden = false;
  loadSessions();
});

async function openSession(id) {
  currentSessionId = id;
  clientSeqCounter = Date.now();
  sessionListSection.hidden = true;
  sessionDetailSection.hidden = false;
  analysisResult.hidden = true;
  analyzeStatus.textContent = "";
  const viewerLink = document.getElementById("openViewerLink");
  viewerLink.href = `/viewer.html?session=${id}`;
  await refreshSegments();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshSegments, 2000);
}

async function refreshSegments() {
  if (!currentSessionId) return;
  const detail = await api(`/api/sessions/${currentSessionId}`);
  sessionTitleEl.textContent = detail.title || "(無題)";
  segmentsEl.innerHTML = "";
  for (const seg of detail.segments) {
    const div = document.createElement("div");
    div.className = "segment-line";
    const time = document.createElement("span");
    time.className = "segment-time";
    time.textContent = new Date(seg.created_at).toLocaleTimeString("ja-JP");
    div.appendChild(time);
    div.appendChild(document.createTextNode(seg.text));
    segmentsEl.appendChild(div);
  }
  segmentsEl.scrollTop = segmentsEl.scrollHeight;
}

segmentForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = segmentText.value.trim();
  if (!text || !currentSessionId) return;
  clientSeqCounter += 1;
  await api(`/api/sessions/${currentSessionId}/segments`, {
    method: "POST",
    body: JSON.stringify({
      segments: [{ clientSeq: clientSeqCounter, text, isFinal: true }],
    }),
  });
  segmentText.value = "";
  await refreshSegments();
});

analyzeBtn.addEventListener("click", async () => {
  if (!currentSessionId) return;
  analysisResult.hidden = true;
  analyzeStatus.textContent = "解析中...";
  const { analysisId } = await api(`/api/sessions/${currentSessionId}/analyze`, {
    method: "POST",
  });
  clearInterval(analyzePollTimer);
  analyzePollTimer = setInterval(() => pollAnalysis(analysisId), 2000);
});

async function pollAnalysis(analysisId) {
  const analysis = await api(`/api/analyses/${analysisId}`);
  if (analysis.status === "queued" || analysis.status === "running") {
    analyzeStatus.textContent = `解析中... (${analysis.status})`;
    return;
  }
  clearInterval(analyzePollTimer);
  if (analysis.status === "error") {
    analyzeStatus.textContent = `エラー: ${analysis.error}`;
    return;
  }
  analyzeStatus.textContent = analysis.result?.parseFallback
    ? "完了（解析結果のパースにフォールバックしました）"
    : "完了";
  const r = analysis.result || {};
  document.getElementById("resSummary").textContent = r.summary || "";
  document.getElementById("resInterpretation").textContent = r.interpretation || "";
  const adviceEl = document.getElementById("resAdvice");
  adviceEl.innerHTML = "";
  for (const item of r.advice || []) {
    const li = document.createElement("li");
    li.textContent = item;
    adviceEl.appendChild(li);
  }
  document.getElementById("resResponse").textContent = r.suggested_response || "";
  analysisResult.hidden = false;
}

loadSessions().catch((err) => {
  console.error(err);
});
