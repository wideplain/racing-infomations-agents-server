package com.example.racingagents.net

import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Retrofit
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import java.util.concurrent.TimeUnit

interface RacingAgentsApi {
    @POST("api/sessions")
    suspend fun createSession(@Body body: CreateSessionRequest): CreateSessionResponse

    @POST("api/sessions/{id}/segments")
    suspend fun postSegments(@Path("id") sessionId: String, @Body body: SegmentsRequest)

    @PATCH("api/sessions/{id}/segments/{clientSeq}")
    suspend fun patchSegment(
        @Path("id") sessionId: String,
        @Path("clientSeq") clientSeq: Long,
        @Body body: PatchSegmentRequest,
    )

    @POST("api/sessions/{id}/analyze")
    suspend fun analyze(@Path("id") sessionId: String, @Body body: AnalyzeRequest): AnalyzeResponse

    @GET("api/analyses/{id}")
    suspend fun getAnalysis(@Path("id") analysisId: String): AnalysisDto
}

/** Adds the shared-secret header the server's preHandler checks on every /api route. */
private class ApiKeyInterceptor(private val apiKeyProvider: () -> String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder()
            .addHeader("X-Api-Key", apiKeyProvider())
            .build()
        return chain.proceed(request)
    }
}

object ApiClientFactory {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    /**
     * baseUrl must end with "/" (Retrofit requirement). apiKeyProvider is read lazily per
     * request so it always reflects the latest Settings value without needing to rebuild
     * the client when the user edits it.
     */
    fun create(baseUrl: String, apiKeyProvider: () -> String): RacingAgentsApi {
        val client = OkHttpClient.Builder()
            // codex exec analysis can take 20-60s per the server design; keep read timeout
            // generous while connect/write stay tight since segments are small and frequent.
            .connectTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .readTimeout(90, TimeUnit.SECONDS)
            .addInterceptor(ApiKeyInterceptor(apiKeyProvider))
            .build()

        val contentType = "application/json".toMediaType()
        val retrofit = Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()

        return retrofit.create(RacingAgentsApi::class.java)
    }
}
