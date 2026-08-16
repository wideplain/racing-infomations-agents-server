package com.example.racingagents.stt

import android.content.Context
import android.media.AudioManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val TAG = "SpeechController"

sealed interface RecognizedSegment {
    data class Partial(val text: String) : RecognizedSegment
    data class Final(val text: String) : RecognizedSegment
}

enum class ListeningState { IDLE, LISTENING, RESTARTING }

/**
 * Drives a continuous on-device Japanese recognition loop on top of [SpeechRecognizer].
 *
 * SpeechRecognizer quirks this class works around (see plan's early-risk list):
 *  - A session auto-stops after ~60s or on silence; onResults/onError is the only reliable
 *    signal to restart, so we always schedule a restart from there rather than relying on a
 *    timer.
 *  - ERROR_RECOGNIZER_BUSY means the underlying service didn't tear down in time; recreating
 *    the whole SpeechRecognizer instance (destroy + new) recovers where a plain
 *    startListening() retry would just loop the same error.
 *  - Rapid destroy/start cycles can themselves throw or no-op; every restart is delayed
 *    150-300ms, and repeated failures back off exponentially up to 5s so a persistent problem
 *    (e.g. no mic permission) doesn't spin-loop.
 *  - startListening() can be invoked while a previous restart is still pending (e.g. two
 *    onError callbacks in a row); isRestartPending guards against scheduling overlapping
 *    restarts which would otherwise surface as spurious BUSY errors.
 */
class SpeechController(
    private val context: Context,
    private val scope: CoroutineScope,
    private val onSegment: (RecognizedSegment) -> Unit,
    private val onStateChanged: (ListeningState) -> Unit,
    private val muteRestartBeepProvider: () -> Boolean,
) {
    private var recognizer: SpeechRecognizer? = null
    private var isRestartPending = false
    private var consecutiveFailures = 0
    private var running = false
    private var restartJob: Job? = null

    // The most recent partial (gray, unconfirmed) text for the in-progress utterance. Android's
    // SpeechRecognizer frequently ends a session via onError (silence timeout, no-match, busy)
    // without ever calling onResults — previously that silently discarded whatever partial text
    // was on screen when the restart-loop kicked in, which looked like "text appears gray, then
    // vanishes and gets replaced" as the next utterance's partials started fresh. Salvaging it as
    // a Final on error keeps every partial the user actually saw from being lost.
    private var lastPartialText: String? = null

    private val audioManager: AudioManager by lazy {
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    }

    fun start() {
        if (running) return
        running = true
        consecutiveFailures = 0
        createRecognizerAndListen()
    }

    fun stop() {
        running = false
        restartJob?.cancel()
        isRestartPending = false
        salvagePartialAsFinal()
        recognizer?.let {
            runCatching { it.stopListening() }
            runCatching { it.destroy() }
        }
        recognizer = null
        onStateChanged(ListeningState.IDLE)
    }

    private fun createRecognizerAndListen() {
        val recognizer = createSpeechRecognizer(context)
        this.recognizer = recognizer
        recognizer.setRecognitionListener(listener)
        beginListening(recognizer)
    }

    private fun beginListening(recognizer: SpeechRecognizer) {
        if (!running) return
        val muted = muteRestartBeepProvider()
        if (muted) muteBeepStream()
        onStateChanged(ListeningState.LISTENING)
        recognizer.startListening(buildRecognizerIntent())
        if (muted) {
            // The beep plays synchronously with startListening's internal service call; a short
            // delayed unmute avoids leaving the stream muted for unrelated audio afterwards.
            scope.launch {
                delay(400)
                unmuteBeepStream()
            }
        }
    }

    private fun muteBeepStream() {
        runCatching { audioManager.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_MUTE, 0) }
    }

    private fun unmuteBeepStream() {
        runCatching { audioManager.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_UNMUTE, 0) }
    }

    private fun scheduleRestart(recreate: Boolean) {
        if (!running || isRestartPending) return
        isRestartPending = true
        onStateChanged(ListeningState.RESTARTING)
        val delayMs = if (consecutiveFailures == 0) {
            (150..300).random().toLong()
        } else {
            (500L * (1 shl consecutiveFailures.coerceAtMost(4))).coerceAtMost(5000L)
        }
        restartJob = scope.launch {
            delay(delayMs)
            isRestartPending = false
            if (!running) return@launch
            if (recreate) {
                recognizer?.let { runCatching { it.destroy() } }
                createRecognizerAndListen()
            } else {
                recognizer?.let { beginListening(it) } ?: createRecognizerAndListen()
            }
        }
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}

        override fun onError(error: Int) {
            salvagePartialAsFinal()
            when (error) {
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> {
                    consecutiveFailures += 1
                    scheduleRestart(recreate = true)
                }
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                    // Normal for a continuous loop (silence gaps); not a failure.
                    consecutiveFailures = 0
                    scheduleRestart(recreate = false)
                }
                else -> {
                    Log.w(TAG, "recognizer error=$error")
                    consecutiveFailures += 1
                    scheduleRestart(recreate = consecutiveFailures >= 2)
                }
            }
        }

        override fun onResults(results: Bundle?) {
            consecutiveFailures = 0
            val text = results
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
            lastPartialText = null
            if (!text.isNullOrBlank()) {
                onSegment(RecognizedSegment.Final(text))
            }
            scheduleRestart(recreate = false)
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
            if (!text.isNullOrBlank()) {
                lastPartialText = text
                onSegment(RecognizedSegment.Partial(text))
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    /** If there's unconfirmed partial text that never reached onResults (a restart triggered by
     * onError, or the user pressing Stop mid-utterance), emit it as Final instead of losing it. */
    private fun salvagePartialAsFinal() {
        val text = lastPartialText
        lastPartialText = null
        if (!text.isNullOrBlank()) {
            onSegment(RecognizedSegment.Final(text))
        }
    }

    companion object {
        fun createSpeechRecognizer(context: Context): SpeechRecognizer {
            return if (SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
                SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            } else {
                SpeechRecognizer.createSpeechRecognizer(context)
            }
        }

    }

    private fun buildRecognizerIntent() = android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ja-JP")
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        // Longer-than-default silence windows so short pauses mid-sentence don't cut a
        // segment early (values in ms; not all OEM recognizers honor these).
        putExtra("android.speech.extra.SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS", 2000)
        putExtra("android.speech.extra.SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS", 2000)
        putExtra("android.speech.extra.SPEECH_INPUT_MINIMUM_LENGTH_MILLIS", 15000)
    }
}
