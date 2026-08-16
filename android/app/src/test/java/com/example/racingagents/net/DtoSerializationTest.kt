package com.example.racingagents.net

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class DtoSerializationTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Test
    fun `SegmentsRequest round-trips through JSON`() {
        val original = SegmentsRequest(
            segments = listOf(
                SegmentDto(clientSeq = 0, text = "こんにちは", isFinal = true, startedAt = 1000, endedAt = 2000),
                SegmentDto(clientSeq = 1, text = "調子どう", isFinal = false, startedAt = 2000, endedAt = 3000),
            ),
        )

        val encoded = json.encodeToString(original)
        val decoded = json.decodeFromString<SegmentsRequest>(encoded)

        assertEquals(original, decoded)
    }

    @Test
    fun `AnalysisDto decodes server field names including suggested_response`() {
        val serverJson = """
            {
              "id": "abc123",
              "status": "done",
              "result": {
                "summary": "要約テキスト",
                "interpretation": "解釈テキスト",
                "advice": ["アドバイス1", "アドバイス2"],
                "suggested_response": "返答案テキスト",
                "confidence": 0.82,
                "notes": null
              }
            }
        """.trimIndent()

        val decoded = json.decodeFromString<AnalysisDto>(serverJson)

        assertEquals("abc123", decoded.id)
        assertEquals("done", decoded.status)
        assertEquals("要約テキスト", decoded.result?.summary)
        assertEquals("返答案テキスト", decoded.result?.suggestedResponse)
        assertEquals(listOf("アドバイス1", "アドバイス2"), decoded.result?.advice)
        assertEquals(0.82, decoded.result?.confidence)
    }

    @Test
    fun `AnalysisDto decodes queued status without a result`() {
        val serverJson = """{"id":"xyz","status":"queued"}"""

        val decoded = json.decodeFromString<AnalysisDto>(serverJson)

        assertEquals("queued", decoded.status)
        assertEquals(null, decoded.result)
    }

    @Test
    fun `CreateSessionRequest and response round-trip`() {
        val request = CreateSessionRequest(title = "テストセッション", deviceId = "device-1")
        val encoded = json.encodeToString(request)
        val decoded = json.decodeFromString<CreateSessionRequest>(encoded)
        assertEquals(request, decoded)

        val response = json.decodeFromString<CreateSessionResponse>("""{"id":"sess-1"}""")
        assertEquals("sess-1", response.id)
    }
}
