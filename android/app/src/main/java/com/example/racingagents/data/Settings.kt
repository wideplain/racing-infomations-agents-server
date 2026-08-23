package com.example.racingagents.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

private val Context.settingsDataStore by preferencesDataStore(name = "settings")

private val premisesJson = Json { ignoreUnknownKeys = true }

/** A reusable, named premise ("応答の前提条件") the crew can prepare ahead of time — e.g. "無線は
 * 短く簡潔に" or "タイヤ交換済み、燃料残量は気にしない" — instead of retyping context into every
 * メモを添えて解析 note. [applied] premises are automatically folded into every analysis instruction
 * until toggled off; unapplied ones stay saved in the list for later. */
@Serializable
data class Premise(
    val id: String,
    val text: String,
    val applied: Boolean = true,
)

data class AppSettings(
    val serverUrl: String = "",
    val apiKey: String = "",
    val muteRestartBeep: Boolean = false,
    val autoAnalysisEnabled: Boolean = false,
    /** Trigger auto-analysis after this many seconds since the last one (0 = interval trigger off). */
    val autoAnalysisIntervalSec: Int = 60,
    /** Trigger auto-analysis after this many new (non-excluded) characters accumulate (0 = char trigger off). */
    val autoAnalysisCharThreshold: Int = 300,
    /** "default" or "pitwall" — sent as the analyze() request body's mode field. */
    val analysisMode: String = "default",
    /** When true, each analysis run also fires an independent "driver" mode request so the
     * web viewer's driver display has a short summary alongside the normal detailed analysis. */
    val driverSummaryEnabled: Boolean = true,
    /** "ja-JP" or "en-US" — the language passed to SpeechRecognizer for transcription. */
    val sttLanguage: String = "ja-JP",
    /** Saved 前提条件 presets; [Premise.applied] ones are folded into every analysis instruction. */
    val premises: List<Premise> = emptyList(),
)

/** Server URL / API key / beep-mute / auto-analysis config, persisted via DataStore preferences. */
class SettingsRepository(private val context: Context) {
    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val API_KEY = stringPreferencesKey("api_key")
        val MUTE_RESTART_BEEP = booleanPreferencesKey("mute_restart_beep")
        val AUTO_ANALYSIS_ENABLED = booleanPreferencesKey("auto_analysis_enabled")
        val AUTO_ANALYSIS_INTERVAL_SEC = intPreferencesKey("auto_analysis_interval_sec")
        val AUTO_ANALYSIS_CHAR_THRESHOLD = intPreferencesKey("auto_analysis_char_threshold")
        val ANALYSIS_MODE = stringPreferencesKey("analysis_mode")
        val DRIVER_SUMMARY_ENABLED = booleanPreferencesKey("driver_summary_enabled")
        val STT_LANGUAGE = stringPreferencesKey("stt_language")
        val PREMISES = stringPreferencesKey("premises_json")
    }

    val settingsFlow: Flow<AppSettings> = context.settingsDataStore.data.map { prefs ->
        AppSettings(
            // Defensive re-clean on every load: a value saved before the paste-sanitization fix
            // (e.g. "**http://..." from a markdown-formatted copy/paste) stays in DataStore until
            // the user retypes it, otherwise. Stripping here means it displays correctly too, not
            // just when building the API client.
            serverUrl = (prefs[Keys.SERVER_URL] ?: "").trim()
                .filterNot { it == '\n' || it == '\r' || it == '*' || it == '`' || it.isWhitespace() },
            apiKey = prefs[Keys.API_KEY] ?: "",
            muteRestartBeep = prefs[Keys.MUTE_RESTART_BEEP] ?: false,
            autoAnalysisEnabled = prefs[Keys.AUTO_ANALYSIS_ENABLED] ?: false,
            autoAnalysisIntervalSec = prefs[Keys.AUTO_ANALYSIS_INTERVAL_SEC] ?: 60,
            autoAnalysisCharThreshold = prefs[Keys.AUTO_ANALYSIS_CHAR_THRESHOLD] ?: 300,
            // "driver" used to be selectable here, which replaced the detailed analysis instead of
            // supplementing it. It's now produced separately via driverSummaryEnabled, so a stored
            // "driver" is migrated to pitwall — otherwise the main analysis would stay driver-shaped
            // and the detailed history would never accumulate again on that device.
            analysisMode = (prefs[Keys.ANALYSIS_MODE] ?: "default").let {
                if (it == "default" || it == "pitwall") it else "pitwall"
            },
            driverSummaryEnabled = prefs[Keys.DRIVER_SUMMARY_ENABLED] ?: true,
            sttLanguage = (prefs[Keys.STT_LANGUAGE] ?: "ja-JP").let {
                if (it == "ja-JP" || it == "en-US") it else "ja-JP"
            },
            premises = runCatching {
                premisesJson.decodeFromString<List<Premise>>(prefs[Keys.PREMISES] ?: "[]")
            }.getOrDefault(emptyList()),
        )
    }

    suspend fun setServerUrl(url: String) {
        context.settingsDataStore.edit { it[Keys.SERVER_URL] = url }
    }

    suspend fun setApiKey(key: String) {
        context.settingsDataStore.edit { it[Keys.API_KEY] = key }
    }

    suspend fun setMuteRestartBeep(enabled: Boolean) {
        context.settingsDataStore.edit { it[Keys.MUTE_RESTART_BEEP] = enabled }
    }

    suspend fun setAutoAnalysisEnabled(enabled: Boolean) {
        context.settingsDataStore.edit { it[Keys.AUTO_ANALYSIS_ENABLED] = enabled }
    }

    suspend fun setAutoAnalysisIntervalSec(seconds: Int) {
        context.settingsDataStore.edit { it[Keys.AUTO_ANALYSIS_INTERVAL_SEC] = seconds.coerceAtLeast(0) }
    }

    suspend fun setAutoAnalysisCharThreshold(chars: Int) {
        context.settingsDataStore.edit { it[Keys.AUTO_ANALYSIS_CHAR_THRESHOLD] = chars.coerceAtLeast(0) }
    }

    suspend fun setAnalysisMode(mode: String) {
        context.settingsDataStore.edit { it[Keys.ANALYSIS_MODE] = mode }
    }

    suspend fun setDriverSummaryEnabled(enabled: Boolean) {
        context.settingsDataStore.edit { it[Keys.DRIVER_SUMMARY_ENABLED] = enabled }
    }

    suspend fun setSttLanguage(lang: String) {
        context.settingsDataStore.edit { it[Keys.STT_LANGUAGE] = lang }
    }

    private fun readPremises(prefs: androidx.datastore.preferences.core.Preferences): List<Premise> =
        runCatching { premisesJson.decodeFromString<List<Premise>>(prefs[Keys.PREMISES] ?: "[]") }
            .getOrDefault(emptyList())

    suspend fun addPremise(text: String) {
        val trimmed = text.trim()
        if (trimmed.isBlank()) return
        context.settingsDataStore.edit { prefs ->
            val updated = readPremises(prefs) + Premise(id = UUID.randomUUID().toString(), text = trimmed)
            prefs[Keys.PREMISES] = premisesJson.encodeToString(updated)
        }
    }

    suspend fun removePremise(id: String) {
        context.settingsDataStore.edit { prefs ->
            prefs[Keys.PREMISES] = premisesJson.encodeToString(readPremises(prefs).filterNot { it.id == id })
        }
    }

    suspend fun setPremiseApplied(id: String, applied: Boolean) {
        context.settingsDataStore.edit { prefs ->
            val updated = readPremises(prefs).map { if (it.id == id) it.copy(applied = applied) else it }
            prefs[Keys.PREMISES] = premisesJson.encodeToString(updated)
        }
    }
}
