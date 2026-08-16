package com.example.racingagents.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.example.racingagents.net.RacingAgentsApi
import com.example.racingagents.net.SegmentDto
import com.example.racingagents.net.SegmentsRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/** A final (or partial-in-flight) segment awaiting/being sent to the server. */
@Serializable
data class PendingSegment(
    val clientSeq: Long,
    val text: String,
    val isFinal: Boolean,
    val startedAt: Long,
    val endedAt: Long,
)

/**
 * Pure logic for clientSeq assignment and the pending buffer, kept free of Android APIs so it
 * can be unit-tested on the plain JVM (see plan's "自動テスト" section). Not thread-safe by
 * itself; callers (SegmentQueue) confine access to a single coroutine dispatcher.
 */
class SegmentQueueCore(startingSeq: Long = 0L) {
    private var nextSeq: Long = startingSeq
    private val pending = ArrayDeque<PendingSegment>()

    val size: Int get() = pending.size

    fun enqueue(text: String, isFinal: Boolean, startedAt: Long, endedAt: Long): PendingSegment {
        val segment = PendingSegment(nextSeq, text, isFinal, startedAt, endedAt)
        nextSeq += 1
        pending.addLast(segment)
        return segment
    }

    /** Up to [max] oldest pending segments, without removing them (removal happens on ack). */
    fun peekBatch(max: Int = 20): List<PendingSegment> = pending.take(max)

    /** Drops the given clientSeqs from the pending buffer after a confirmed successful send. */
    fun ack(clientSeqs: Collection<Long>) {
        if (clientSeqs.isEmpty()) return
        val ackSet = clientSeqs.toHashSet()
        pending.removeAll { it.clientSeq in ackSet }
    }

    fun snapshot(): List<PendingSegment> = pending.toList()

    /** Restores a previously persisted snapshot (e.g. from DataStore) and resumes seq numbering. */
    fun restore(segments: List<PendingSegment>) {
        pending.clear()
        pending.addAll(segments)
        val maxRestoredSeq = segments.maxOfOrNull { it.clientSeq } ?: (startingSeqFloor())
        if (maxRestoredSeq + 1 > nextSeq) {
            nextSeq = maxRestoredSeq + 1
        }
    }

    private fun startingSeqFloor(): Long = nextSeq - 1
}

/**
 * Backoff schedule for the drain loop: exponential from 1s, capped at 30s, per plan
 * ("バックオフ 1s→30s"). Pure function so it's directly unit-testable.
 */
fun computeBackoffMillis(consecutiveFailures: Int): Long {
    if (consecutiveFailures <= 0) return 0L
    val exp = 1000L shl (consecutiveFailures - 1).coerceAtMost(5) // 1s,2s,4s,8s,16s,32s(->capped)
    return exp.coerceAtMost(30_000L)
}

private val Context.segmentQueueDataStore by preferencesDataStore(name = "segment_queue")

/**
 * Wraps [SegmentQueueCore] with DataStore-backed persistence (snapshot on stop/app-death) and a
 * drain coroutine that retries with [computeBackoffMillis] backoff. Server-side idempotency on
 * (sessionId, clientSeq) means re-sending after a crash/restart is always safe.
 */
class SegmentQueue(
    private val context: Context,
    private val api: RacingAgentsApi,
    private val sessionIdProvider: () -> String?,
    private val scope: CoroutineScope,
    // Must continue from the highest clientSeq already used (e.g. by a restored, persisted
    // transcript), otherwise a fresh queue restarting at 0 collides with old entries that are
    // still on screen — Compose's LazyColumn requires unique keys and crashes on the collision.
    startingSeq: Long = 0L,
) {
    private val core = SegmentQueueCore(startingSeq)
    private val json = Json { ignoreUnknownKeys = true }
    private val snapshotKey = stringPreferencesKey("pending_segments_json")

    private val _pendingCount = MutableStateFlow(0)
    val pendingCount: StateFlow<Int> = _pendingCount

    /** clientSeqs not yet confirmed sent; a transcript line is "synced" once its seq leaves this set. */
    private val _pendingSeqs = MutableStateFlow<Set<Long>>(emptySet())
    val pendingSeqs: StateFlow<Set<Long>> = _pendingSeqs

    private val _lastSendError = MutableStateFlow<String?>(null)
    val lastSendError: StateFlow<String?> = _lastSendError

    private var drainJob: Job? = null

    fun enqueue(text: String, isFinal: Boolean, startedAt: Long, endedAt: Long): Long {
        val segment = core.enqueue(text, isFinal, startedAt, endedAt)
        _pendingCount.value = core.size
        _pendingSeqs.value = core.snapshot().map { it.clientSeq }.toSet()
        startDrainLoopIfNeeded()
        return segment.clientSeq
    }

    suspend fun restoreFromSnapshot() {
        val raw = context.segmentQueueDataStore.data.first()[snapshotKey] ?: return
        runCatching { json.decodeFromString<List<PendingSegment>>(raw) }
            .onSuccess {
                core.restore(it)
                _pendingCount.value = core.size
                _pendingSeqs.value = core.snapshot().map { it.clientSeq }.toSet()
                if (it.isNotEmpty()) startDrainLoopIfNeeded()
            }
    }

    suspend fun snapshotToDataStore() {
        val snapshot = core.snapshot()
        context.segmentQueueDataStore.edit { prefs ->
            prefs[snapshotKey] = json.encodeToString(snapshot)
        }
    }

    /** Drops every not-yet-uploaded segment, in memory and on disk. Used when starting a new
     * session: otherwise the previous conversation's undelivered backlog would drain into the
     * fresh session, and the persisted snapshot would resurrect it on the next restore. */
    suspend fun clearAll() {
        drainJob?.cancel()
        drainJob = null
        core.restore(emptyList())
        _pendingCount.value = 0
        _pendingSeqs.value = emptySet()
        _lastSendError.value = null
        context.segmentQueueDataStore.edit { prefs ->
            prefs[snapshotKey] = json.encodeToString(emptyList<PendingSegment>())
        }
    }

    private fun startDrainLoopIfNeeded() {
        if (drainJob?.isActive == true) return
        drainJob = scope.launch {
            var consecutiveFailures = 0
            while (core.size > 0) {
                val sessionId = sessionIdProvider()
                if (sessionId == null) {
                    delay(1000)
                    continue
                }
                val batch = core.peekBatch(20)
                if (batch.isEmpty()) break
                val result = runCatching {
                    api.postSegments(
                        sessionId,
                        SegmentsRequest(batch.map {
                            SegmentDto(it.clientSeq, it.text, it.isFinal, it.startedAt, it.endedAt)
                        }),
                    )
                }
                if (result.isSuccess) {
                    core.ack(batch.map { it.clientSeq })
                    _pendingCount.value = core.size
                    _pendingSeqs.value = core.snapshot().map { it.clientSeq }.toSet()
                    _lastSendError.value = null
                    consecutiveFailures = 0
                } else {
                    val e = result.exceptionOrNull()
                    _lastSendError.value = "送信失敗: ${e?.message ?: e?.let { it::class.simpleName }}"
                    consecutiveFailures += 1
                    delay(computeBackoffMillis(consecutiveFailures))
                }
            }
        }
    }
}
