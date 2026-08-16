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

async function api(path) {
  const res = await fetch(path, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

const sessionId = new URLSearchParams(location.search).get("session");
const noSessionSection = document.getElementById("noSessionSection");
const viewerSection = document.getElementById("viewerSection");
const pageTitle = document.getElementById("pageTitle");
const segmentsEl = document.getElementById("segments");
const analysesEl = document.getElementById("analyses");

if (!sessionId) {
  noSessionSection.hidden = false;
} else {
  viewerSection.hidden = false;
  pageTitle.textContent = `ビュワー - ${sessionId.slice(0, 8)}`;
  refreshSegments();
  refreshAnalyses();
  setInterval(refreshSegments, 2000);
  setInterval(refreshAnalyses, 3000);
}

// Collapsed accordion sections shouldn't keep reserving their expanded flex share — mark the
// parent column so it shrinks to just the summary's height (mobile) / stops stretching (desktop),
// letting the still-open sibling column take the freed space. See viewer.css `.viewer-col.collapsed`.
document.querySelectorAll(".viewer-col > details").forEach((details) => {
  const col = details.closest(".viewer-col");
  const sync = () => col.classList.toggle("collapsed", !details.open);
  details.addEventListener("toggle", sync);
  sync();
});

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
    return;
  }
  // Rebuilding via innerHTML="" resets scrollTop to 0, which would yank the view back to the
  // top on every 2s poll while someone is reading older lines. Preserve their position unless
  // they were already following the live tail.
  const prevScrollTop = segmentsEl.scrollTop;
  segmentsEl.innerHTML = "";
  for (const seg of session.segments || []) {
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

let analysesAtBottom = true;
analysesEl.addEventListener("scroll", () => {
  analysesAtBottom = analysesEl.scrollHeight - analysesEl.scrollTop - analysesEl.clientHeight < 40;
});

async function refreshAnalyses() {
  let list;
  try {
    list = await api(`/api/sessions/${sessionId}/analyses`);
  } catch (err) {
    console.error(err);
    return;
  }
  const prevScrollTop = analysesEl.scrollTop;
  analysesEl.innerHTML = "";
  for (const a of list) {
    analysesEl.appendChild(renderAnalysisEntry(a));
  }
  analysesEl.scrollTop = analysesAtBottom ? analysesEl.scrollHeight : prevScrollTop;
}

function renderAnalysisEntry(a) {
  const div = document.createElement("div");
  div.className = "analysis-entry";
  const time = new Date(a.created_at).toLocaleTimeString("ja-JP");
  const modeLabel = a.mode === "pitwall" ? "ピットウォール" : "通常";
  const modeClass = a.mode === "pitwall" ? "pitwall" : "";
  let body = "";

  if (a.status === "queued") body = `<p class="status-queued">解析待ち…</p>`;
  else if (a.status === "running") body = `<p class="status-running">解析中…</p>`;
  else if (a.status === "error") body = `<p class="warn">エラー: ${escapeHtml(a.error || "不明")}</p>`;
  else if (a.status === "done" && a.result) {
    body = a.mode === "pitwall" ? renderPitwall(a.result) : renderDefault(a.result);
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
