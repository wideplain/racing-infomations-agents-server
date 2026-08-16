package com.example.racingagents.ui

import android.content.Context
import android.provider.Settings.Secure
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.example.racingagents.data.AppSettings
import com.example.racingagents.data.SegmentQueue
import com.example.racingagents.data.SettingsRepository
import com.example.racingagents.data.StoredTranscriptLine
import com.example.racingagents.data.TranscriptStore
import com.example.racingagents.net.AnalysisDto
import com.example.racingagents.net.AnalyzeRequest
import com.example.racingagents.net.ApiClientFactory
import com.example.racingagents.net.CreateSessionRequest
import com.example.racingagents.net.PatchSegmentRequest
import com.example.racingagents.net.RacingAgentsApi
import com.example.racingagents.stt.ListeningState
import com.example.racingagents.stt.RecognizedSegment
import com.example.racingagents.stt.SttForegroundService
import com.example.racingagents.stt.SttServiceHolder
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class AnalysisStatus { QUEUED, RUNNING, DONE, ERROR }

/** MANUAL = user pressed the AI解析 button; AUTO = interval/char-count threshold fired. Kept
 * as separate timelines in the UI (two side-by-side columns) so auto runs don't bury manual ones. */
enum class AnalysisTrigger { MANUAL, AUTO }

/** One AI解析 run in the timeline: [requestedAt] is when the AI解析 button was pressed, so the
 * history reads like a timestamped log rather than a single overwritten result. */
data class AnalysisEntry(
    val localId: Long,
    val requestedAt: Long,
    val status: AnalysisStatus,
    val trigger: AnalysisTrigger = AnalysisTrigger.MANUAL,
    val result: AnalysisDto? = null,
    val errorMessage: String? = null,
    /** The free-text note attached when this run was triggered, if any (manual runs only). */
    val instruction: String? = null,
)

/** A transcript line, colored dark once [synced] (server confirmed) vs gray while pending upload.
 * [excluded] lines are archived out of the AI解析 context; [isUpdating] guards double-taps while
 * an edit/archive PATCH is in flight. [recognizedAt] backs the per-line timestamp shown in the UI. */
data class TranscriptLine(
    val clientSeq: Long,
    val text: String,
    val recognizedAt: Long,
    val synced: Boolean,
    val excluded: Boolean = false,
    val isUpdating: Boolean = false,
    // Compose LazyColumn identity key. Deliberately separate from clientSeq: clientSeq is
    // server-facing numbering that legitimately restarts at 0 whenever a new SegmentQueue is
    // created (new session, settings rebuild) and can collide with older restored/visible lines
    // sharing the same number — which previously crashed the LazyColumn ("Key already used").
    // localId is assigned once per line, purely for UI identity, and never reused.
    val localId: Long,
)

data class MainUiState(
    val settings: AppSettings = AppSettings(),
    val sessionId: String? = null,
    val listeningState: ListeningState = ListeningState.IDLE,
    val livePartialText: String = "",
    val transcript: List<TranscriptLine> = emptyList(),
    val pendingCount: Int = 0,
    val analysisHistory: List<AnalysisEntry> = emptyList(),
    val showSettingsSheet: Boolean = false,
    val lastErrorMessage: String? = null,
)

/** Status chip label per plan: 待機中/認識中/再接続中/送信待ちN件. */
fun MainUiState.statusChipText(): String = when {
    pendingCount > 0 -> "送信待ち${pendingCount}件"
    listeningState == ListeningState.LISTENING -> "認識中"
    listeningState == ListeningState.RESTARTING -> "再接続中"
    else -> "待機中"
}

class MainViewModel(private val context: Context) : ViewModel() {
    private val settingsRepository = SettingsRepository(context)
    private val deviceId: String =
        Secure.getString(context.contentResolver, Secure.ANDROID_ID) ?: "unknown-device"

    private var api: RacingAgentsApi? = null
    private var segmentQueue: SegmentQueue? = null
    private val transcriptStore = TranscriptStore(context)

    // Monotonic counter for TranscriptLine.localId. Only ever touched from the main thread
    // (ViewModel callbacks / Compose), so a plain var is safe without extra synchronization.
    private var localIdCounter = 0L
    private fun nextLocalId(): Long = localIdCounter++

    private val _uiState = MutableStateFlow(MainUiState())
    val uiState: StateFlow<MainUiState> = _uiState

    private val analyzePollingJobs = mutableMapOf<Long, kotlinx.coroutines.Job>()

    // Auto-analysis bookkeeping: how much non-excluded, synced transcript existed at the last
    // auto run, and when that run fired, so both the char-count and interval triggers only fire
    // once per threshold crossing and never re-analyze unchanged content.
    private var lastAutoAnalysisAt: Long = System.currentTimeMillis()
    private var lastAutoAnalysisCharCount: Int = 0

    init {
        viewModelScope.launch {
            // Restore transcript history BEFORE anything else starts — settingsFlow's collector
            // (below) builds the SegmentQueue and seeds its clientSeq counter from whatever is in
            // uiState.transcript at that moment; if it ran first with an empty transcript, new
            // segments would restart clientSeq at 0 and collide with the just-restored old lines
            // once they load (Compose's LazyColumn requires unique keys and crashes on that).
            val restored = transcriptStore.load()
            if (restored.isNotEmpty()) {
                _uiState.update {
                    it.copy(transcript = restored.map { line ->
                        TranscriptLine(line.clientSeq, line.text, line.recognizedAt, line.synced, line.excluded, localId = nextLocalId())
                    })
                }
            }

            launch {
                settingsRepository.settingsFlow.collect { settings ->
                    _uiState.update { it.copy(settings = settings) }
                    rebuildApiClientIfNeeded(settings)
                }
            }

            // Persist on every transcript change (new lines, sync-status flips, edits/archives)
            // rather than at scattered call sites, so nothing can slip through and fail to
            // survive a restart. `uiState.collect` immediately emits the *current* value on
            // subscribe — starting this only after the restore above means that first emission
            // already reflects the restored data, so it can't clobber the file with an empty list.
            var previous: List<TranscriptLine>? = null
            uiState.collect { state ->
                if (state.transcript !== previous) {
                    previous = state.transcript
                    persistTranscript(state.transcript)
                }
            }
        }
        viewModelScope.launch {
            SttServiceHolder.state.collect { sttState ->
                _uiState.update {
                    it.copy(
                        listeningState = sttState.listeningState,
                        livePartialText = sttState.livePartialText,
                    )
                }
            }
        }
        viewModelScope.launch { autoAnalysisLoop() }
        viewModelScope.launch {
            SttServiceHolder.finalSegments.collect { segment ->
                if (segment != null) onFinalSegment(segment)
            }
        }
    }

    /** Persists the current transcript so it survives a process restart (see restore in init). */
    private fun persistTranscript(transcript: List<TranscriptLine>) {
        viewModelScope.launch {
            transcriptStore.save(transcript.map {
                StoredTranscriptLine(it.clientSeq, it.text, it.recognizedAt, it.synced, it.excluded)
            })
        }
    }

    private fun rebuildApiClientIfNeeded(settings: AppSettings) {
        val cleanedUrl = settings.serverUrl.trim()
            .filterNot { it == '\n' || it == '\r' || it == '*' || it == '`' || it.isWhitespace() }
        if (cleanedUrl.isBlank()) return
        val normalizedUrl = if (cleanedUrl.endsWith("/")) cleanedUrl else "$cleanedUrl/"
        // A malformed URL (bad scheme, stray characters, mid-typing state while the user edits
        // the settings field) must never crash the app — OkHttp/Retrofit throw synchronously
        // from Retrofit.Builder.baseUrl(), so this is caught here rather than propagating out of
        // the settingsFlow collector (which previously took the whole process down).
        val newApi = runCatching { ApiClientFactory.create(normalizedUrl) { _uiState.value.settings.apiKey } }
            .onFailure { e ->
                _uiState.update { it.copy(lastErrorMessage = "サーバーURLが不正です: ${e.message ?: e::class.simpleName}") }
            }
            .getOrNull() ?: return
        api = newApi
        val nextSeq = (_uiState.value.transcript.maxOfOrNull { it.clientSeq } ?: -1L) + 1
        segmentQueue = SegmentQueue(
            context = context,
            api = newApi,
            sessionIdProvider = { _uiState.value.sessionId },
            scope = viewModelScope,
            startingSeq = nextSeq,
        )
        viewModelScope.launch { segmentQueue?.restoreFromSnapshot() }
        viewModelScope.launch {
            segmentQueue?.pendingCount?.collect { count ->
                _uiState.update { it.copy(pendingCount = count) }
            }
        }
        viewModelScope.launch {
            segmentQueue?.pendingSeqs?.collect { pending ->
                _uiState.update { state ->
                    state.copy(transcript = state.transcript.map { line ->
                        if (line.synced || line.clientSeq !in pending) line.copy(synced = line.clientSeq !in pending) else line
                    })
                }
            }
        }
        viewModelScope.launch {
            segmentQueue?.lastSendError?.collect { message ->
                if (message != null) _uiState.update { it.copy(lastErrorMessage = message) }
            }
        }
    }

    private fun onFinalSegment(segment: RecognizedSegment.Final) {
        val now = System.currentTimeMillis()
        val queue = segmentQueue
        val clientSeq = queue?.enqueue(segment.text, isFinal = true, startedAt = now, endedAt = now)
        _uiState.update {
            it.copy(transcript = it.transcript + TranscriptLine(clientSeq ?: -1L, segment.text, recognizedAt = now, synced = false, localId = nextLocalId()))
        }
    }

    /** Edits text and/or toggles archive (AI解析から除外) for an already-synced line.
     * No-op for lines still pending upload — they don't exist on the server yet to PATCH. */
    fun updateTranscriptLine(clientSeq: Long, newText: String? = null, excluded: Boolean? = null) {
        val currentApi = api ?: return
        val sessionId = _uiState.value.sessionId ?: return
        val line = _uiState.value.transcript.find { it.clientSeq == clientSeq } ?: return
        if (!line.synced || line.isUpdating) return

        _uiState.update { state ->
            state.copy(transcript = state.transcript.map {
                if (it.clientSeq == clientSeq) it.copy(isUpdating = true) else it
            })
        }
        viewModelScope.launch {
            val result = runCatching {
                currentApi.patchSegment(sessionId, clientSeq, PatchSegmentRequest(text = newText, excluded = excluded))
            }
            _uiState.update { state ->
                state.copy(
                    transcript = state.transcript.map {
                        if (it.clientSeq != clientSeq) return@map it
                        if (result.isSuccess) {
                            it.copy(
                                text = newText ?: it.text,
                                excluded = excluded ?: it.excluded,
                                isUpdating = false,
                            )
                        } else {
                            it.copy(isUpdating = false)
                        }
                    },
                    lastErrorMessage = result.exceptionOrNull()?.let { e -> "更新失敗: ${e.message ?: e::class.simpleName}" }
                        ?: state.lastErrorMessage,
                )
            }
        }
    }

    fun onServerUrlChanged(url: String) = viewModelScope.launch { settingsRepository.setServerUrl(url) }
    fun onApiKeyChanged(key: String) = viewModelScope.launch { settingsRepository.setApiKey(key) }
    fun onMuteBeepChanged(enabled: Boolean) = viewModelScope.launch { settingsRepository.setMuteRestartBeep(enabled) }
    fun onAutoAnalysisEnabledChanged(enabled: Boolean) = viewModelScope.launch { settingsRepository.setAutoAnalysisEnabled(enabled) }
    fun onAutoAnalysisIntervalChanged(seconds: Int) = viewModelScope.launch { settingsRepository.setAutoAnalysisIntervalSec(seconds) }
    fun onAutoAnalysisCharThresholdChanged(chars: Int) = viewModelScope.launch { settingsRepository.setAutoAnalysisCharThreshold(chars) }
    fun onAnalysisModeChanged(mode: String) = viewModelScope.launch { settingsRepository.setAnalysisMode(mode) }

    fun openSettingsSheet() = _uiState.update { it.copy(showSettingsSheet = true) }
    fun closeSettingsSheet() = _uiState.update { it.copy(showSettingsSheet = false) }

    fun startSession() {
        val currentApi = api
        if (currentApi == null) {
            _uiState.update { it.copy(lastErrorMessage = "サーバーURLが未設定です") }
            return
        }
        viewModelScope.launch {
            runCatching { currentApi.createSession(CreateSessionRequest(title = "session", deviceId = deviceId)) }
                .onSuccess { response -> _uiState.update { it.copy(sessionId = response.id, lastErrorMessage = null) } }
                .onFailure { e ->
                    _uiState.update { it.copy(lastErrorMessage = "セッション作成失敗: ${e.message ?: e::class.simpleName}") }
                }
        }
    }

    /** Explicitly starts a fresh session, clearing the on-screen/on-disk transcript and analysis
     * history so a new conversation doesn't visually mix with the previous one (and so the
     * clientSeq counter restarts at 0 without colliding with the old session's — see
     * rebuildApiClientIfNeeded). The previous session's data is untouched on the server; this
     * only resets what this device is actively viewing/recording into. */
    fun startNewSession() {
        analyzePollingJobs.values.forEach { it.cancel() }
        analyzePollingJobs.clear()
        lastAutoAnalysisAt = System.currentTimeMillis()
        lastAutoAnalysisCharCount = 0
        _uiState.update {
            it.copy(
                sessionId = null,
                transcript = emptyList(),
                pendingCount = 0,
                analysisHistory = emptyList(),
                lastErrorMessage = null,
            )
        }
        // Rebuild so the SegmentQueue's clientSeq counter restarts at 0 alongside the now-empty
        // transcript, instead of continuing from the previous session's highest clientSeq.
        rebuildApiClientIfNeeded(_uiState.value.settings)
        startSession()
    }

    fun startListening() {
        if (_uiState.value.sessionId == null) startSession()
        SttForegroundService.start(context, muteRestartBeep = _uiState.value.settings.muteRestartBeep)
    }

    fun stopListening() {
        SttForegroundService.stop(context)
        viewModelScope.launch { segmentQueue?.snapshotToDataStore() }
    }

    /** Analyses run one at a time on the server (its SerialQueue is concurrency-1), but each call
     * appends a new timestamped entry to the timeline rather than overwriting the last result.
     * Manual and auto runs poll independently (keyed by localId) so triggering one never cancels
     * the other's in-flight polling — they render in separate columns and shouldn't interfere. */
    fun runAnalysis(trigger: AnalysisTrigger = AnalysisTrigger.MANUAL, instruction: String? = null) {
        val currentApi = api ?: return
        val sessionId = _uiState.value.sessionId ?: return

        val localId = System.currentTimeMillis().let { base ->
            // Guard against manual+auto firing in the same millisecond, which would collide keys.
            if (analyzePollingJobs.containsKey(base)) base + 1 else base
        }
        val requestedAt = localId
        val cleanedInstruction = instruction?.trim()?.ifBlank { null }
        _uiState.update {
            it.copy(analysisHistory = it.analysisHistory + AnalysisEntry(
                localId, requestedAt, AnalysisStatus.QUEUED, trigger = trigger, instruction = cleanedInstruction,
            ))
        }

        fun updateEntry(transform: (AnalysisEntry) -> AnalysisEntry) {
            _uiState.update { state ->
                state.copy(analysisHistory = state.analysisHistory.map { if (it.localId == localId) transform(it) else it })
            }
        }

        val analysisMode = _uiState.value.settings.analysisMode
        analyzePollingJobs[localId] = viewModelScope.launch {
            val analyzeResult = runCatching {
                currentApi.analyze(sessionId, AnalyzeRequest(mode = analysisMode, instruction = instruction?.trim()?.ifBlank { null }))
            }
            val analysisId = analyzeResult.getOrNull()?.analysisId
            if (analysisId == null) {
                updateEntry { it.copy(status = AnalysisStatus.ERROR, errorMessage = "解析の開始に失敗しました") }
                analyzePollingJobs.remove(localId)
                return@launch
            }
            // Server-side codex exec latency is ~20-60s per plan; poll at 1s per plan's spec.
            while (true) {
                val poll = runCatching { currentApi.getAnalysis(analysisId) }
                val dto = poll.getOrNull()
                if (dto == null) {
                    delay(1000)
                    continue
                }
                when (dto.status) {
                    "queued" -> updateEntry { it.copy(status = AnalysisStatus.QUEUED, result = dto) }
                    "running" -> updateEntry { it.copy(status = AnalysisStatus.RUNNING, result = dto) }
                    "done" -> {
                        updateEntry { it.copy(status = AnalysisStatus.DONE, result = dto) }
                        analyzePollingJobs.remove(localId)
                        return@launch
                    }
                    "error" -> {
                        updateEntry { it.copy(status = AnalysisStatus.ERROR, result = dto, errorMessage = dto.error) }
                        analyzePollingJobs.remove(localId)
                        return@launch
                    }
                }
                delay(1000)
            }
        }
    }

    /** Polls settings + transcript every 5s and fires an AUTO 解析 when the configured interval
     * or new-character threshold is crossed (only if there's actually new content to analyze). */
    private suspend fun autoAnalysisLoop() {
        while (true) {
            delay(5000)
            val state = _uiState.value
            val settings = state.settings
            if (!settings.autoAnalysisEnabled || state.sessionId == null) continue

            val currentChars = state.transcript.filter { it.synced && !it.excluded }.sumOf { it.text.length }
            if (currentChars <= lastAutoAnalysisCharCount) continue // nothing new to analyze

            val now = System.currentTimeMillis()
            val intervalTrigger = settings.autoAnalysisIntervalSec > 0 &&
                (now - lastAutoAnalysisAt) >= settings.autoAnalysisIntervalSec * 1000L
            val charTrigger = settings.autoAnalysisCharThreshold > 0 &&
                (currentChars - lastAutoAnalysisCharCount) >= settings.autoAnalysisCharThreshold

            if (intervalTrigger || charTrigger) {
                lastAutoAnalysisAt = now
                lastAutoAnalysisCharCount = currentChars
                runAnalysis(AnalysisTrigger.AUTO)
            }
        }
    }

    companion object {
        fun factory(context: Context): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return MainViewModel(context) as T
            }
        }
    }
}
