package com.example.racingagents.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.jsonPrimitive

@Serializable
data class CreateSessionRequest(
    val title: String,
    val deviceId: String,
)

@Serializable
data class AnalyzeRequest(
    val mode: String,
    /** Optional free-text note attached to a single manual analysis run (e.g. context the STT
     * couldn't capture, a specific question to focus on). Null/omitted for auto-triggered runs. */
    val instruction: String? = null,
)

@Serializable
data class CreateSessionResponse(
    val id: String,
)

@Serializable
data class SegmentDto(
    val clientSeq: Long,
    val text: String,
    val isFinal: Boolean,
    val startedAt: Long,
    val endedAt: Long,
)

@Serializable
data class SegmentsRequest(
    val segments: List<SegmentDto>,
)

@Serializable
data class PatchSegmentRequest(
    val text: String? = null,
    val excluded: Boolean? = null,
)

@Serializable
data class AnalyzeResponse(
    val analysisId: String,
)

@Serializable
data class AnalysisResultDto(
    val summary: String? = null,
    val interpretation: String? = null,
    val advice: List<String> = emptyList(),
    @SerialName("suggested_response") val suggestedResponse: String? = null,
    // "confidence" is a NUMBER (0.0-1.0) in default-mode results but a STRING enum
    // ("low"/"medium"/"high") in pitwall-mode results. JsonElement lets deserialization accept
    // either shape without crashing; use confidenceText() to render it.
    val confidence: JsonElement? = null,
    val notes: String? = null,
    // Pitwall-mode-only fields (null/empty in default mode).
    val statusSummary: String? = null,
    val change: String? = null,
    val question: String? = null,
    val proposal: String? = null,
    val needsReview: Boolean? = null,
    val facts: List<String> = emptyList(),
    val warnings: List<String> = emptyList(),
    // Driver-mode-only fields (null in default/pitwall modes).
    val headline: String? = null,
    val action: String? = null,
    val watch: String? = null,
    val urgency: String? = null,
    /** Optional JMA-based precipitation heads-up attached by the server to driver results. */
    val rainEtaMinutes: Int? = null,
    val rainProbability: Int? = null,
    /** Optional JMA weather forecast, including clear conditions when rain is not expected. */
    val forecastEtaMinutes: Int? = null,
    val forecastWeather: String? = null,
) {
    /** Renders [confidence] for display regardless of whether it came in as a number
     * (default mode, e.g. 0.78 -> "78%") or a low/medium/high string (pitwall mode -> 低/中/高). */
    fun confidenceText(): String {
        val primitive = confidence as? JsonPrimitive ?: return "-"
        if (!primitive.isString) {
            val value = primitive.floatOrNull ?: return "-"
            return "${(value * 100).toInt()}%"
        }
        return when (primitive.jsonPrimitive.content) {
            "low" -> "低"
            "medium" -> "中"
            "high" -> "高"
            else -> primitive.content
        }
    }
}

@Serializable
data class AnalysisDto(
    val id: String,
    val status: String, // queued | running | done | error
    val result: AnalysisResultDto? = null,
    val error: String? = null,
)
