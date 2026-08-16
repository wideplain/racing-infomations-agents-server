package com.example.racingagents.stt

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.android.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

private const val CHANNEL_ID = "stt_foreground"
private const val NOTIFICATION_ID = 1001
const val ACTION_STOP = "com.example.racingagents.stt.ACTION_STOP"

/** Segments the service has recognized since the app process started, exposed for the UI/ViewModel. */
data class SttUiState(
    val listeningState: ListeningState = ListeningState.IDLE,
    val livePartialText: String = "",
)

/**
 * Owns the SpeechRecognizer lifecycle in a foregroundServiceType="microphone" service so
 * continuous recognition survives the activity going to the background / screen off. UI observes
 * [SttServiceHolder.state] rather than binding, since the service is only ever start/stopped.
 */
object SttServiceHolder {
    private val _state = MutableStateFlow(SttUiState())
    val state: StateFlow<SttUiState> = _state

    private val _finalSegments = MutableStateFlow<RecognizedSegment.Final?>(null)
    /** Emits the most recent final segment; the ViewModel collects and enqueues it. */
    val finalSegments: StateFlow<RecognizedSegment.Final?> = _finalSegments

    fun updateListeningState(newState: ListeningState) {
        _state.value = _state.value.copy(listeningState = newState)
    }

    fun updatePartial(text: String) {
        _state.value = _state.value.copy(livePartialText = text)
    }

    fun emitFinal(segment: RecognizedSegment.Final) {
        _state.value = _state.value.copy(livePartialText = "")
        _finalSegments.value = segment
    }
}

class SttForegroundService : Service() {
    private val serviceJob = SupervisorJob()
    private val serviceScope = CoroutineScope(serviceJob + Handler(Looper.getMainLooper()).asCoroutineDispatcher())

    private var controller: SpeechController? = null
    private var muteRestartBeep: Boolean = false
    private var sttLanguage: String = "ja-JP"

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopListeningAndSelf()
            return START_NOT_STICKY
        }
        muteRestartBeep = intent?.getBooleanExtra(EXTRA_MUTE_BEEP, false) ?: false
        sttLanguage = intent?.getStringExtra(EXTRA_STT_LANGUAGE) ?: "ja-JP"
        startForeground(NOTIFICATION_ID, buildNotification(ListeningState.LISTENING))
        startRecognition()
        return START_STICKY
    }

    private fun startRecognition() {
        if (controller != null) return
        controller = SpeechController(
            context = this,
            scope = serviceScope,
            onSegment = { segment ->
                when (segment) {
                    is RecognizedSegment.Partial -> SttServiceHolder.updatePartial(segment.text)
                    is RecognizedSegment.Final -> SttServiceHolder.emitFinal(segment)
                }
            },
            onStateChanged = { state ->
                SttServiceHolder.updateListeningState(state)
                updateNotification(state)
            },
            muteRestartBeepProvider = { muteRestartBeep },
            languageProvider = { sttLanguage },
        ).also { it.start() }
    }

    private fun stopListeningAndSelf() {
        controller?.stop()
        controller = null
        SttServiceHolder.updateListeningState(ListeningState.IDLE)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        controller?.stop()
        controller = null
        serviceJob.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "音声認識",
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun updateNotification(state: ListeningState) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(state))
    }

    private fun buildNotification(state: ListeningState): Notification {
        val stopIntent = Intent(this, SttForegroundService::class.java).apply { action = ACTION_STOP }
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val statusText = when (state) {
            ListeningState.LISTENING -> "認識中"
            ListeningState.RESTARTING -> "再接続中"
            ListeningState.IDLE -> "待機中"
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("音声を記録しています")
            .setContentText(statusText)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .addAction(0, "停止", stopPendingIntent)
            .build()
    }

    companion object {
        const val EXTRA_MUTE_BEEP = "mute_beep"
        const val EXTRA_STT_LANGUAGE = "stt_language"

        fun start(context: Context, muteRestartBeep: Boolean, sttLanguage: String) {
            val intent = Intent(context, SttForegroundService::class.java)
                .putExtra(EXTRA_MUTE_BEEP, muteRestartBeep)
                .putExtra(EXTRA_STT_LANGUAGE, sttLanguage)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, SttForegroundService::class.java).apply { action = ACTION_STOP }
            context.startService(intent)
        }
    }
}
