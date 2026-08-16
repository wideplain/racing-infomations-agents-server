package com.example.racingagents.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** A transcript line as persisted on-device. [synced] reflects whatever was last known — it is
 * re-derived from the live SegmentQueue right after restore, since sends may have completed
 * while the app was closed. */
@Serializable
data class StoredTranscriptLine(
    val clientSeq: Long,
    val text: String,
    val recognizedAt: Long,
    val synced: Boolean,
    val excluded: Boolean = false,
)

private val Context.transcriptDataStore by preferencesDataStore(name = "transcript")

/**
 * Keeps the full recognized-speech history on the phone regardless of network conditions —
 * poor signal only slows the upload queue (see SegmentQueue), it must never make already-
 * recognized text disappear from the screen. Persisted so it also survives a process restart,
 * not just app backgrounding.
 */
class TranscriptStore(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val key = stringPreferencesKey("transcript_lines_json")

    /** Caps stored history so a multi-hour session doesn't grow the snapshot file unbounded. */
    private val maxStoredLines = 1000

    suspend fun load(): List<StoredTranscriptLine> {
        val raw = context.transcriptDataStore.data.first()[key] ?: return emptyList()
        return runCatching { json.decodeFromString<List<StoredTranscriptLine>>(raw) }.getOrDefault(emptyList())
    }

    suspend fun save(lines: List<StoredTranscriptLine>) {
        val trimmed = if (lines.size > maxStoredLines) lines.takeLast(maxStoredLines) else lines
        context.transcriptDataStore.edit { it[key] = json.encodeToString(trimmed) }
    }
}
