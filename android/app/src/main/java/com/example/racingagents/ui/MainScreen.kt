package com.example.racingagents.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Locale

private val transcriptTimeFormat = SimpleDateFormat("HH:mm:ss", Locale.JAPAN)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    viewModel: MainViewModel,
    onRequestPermissions: () -> Unit,
) {
    val uiState by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var editingLine by remember { mutableStateOf<TranscriptLine?>(null) }
    var showInstructionDialog by remember { mutableStateOf(false) }
    var transcriptExpanded by remember { mutableStateOf(true) }
    var showNewSessionConfirm by remember { mutableStateOf(false) }

    LaunchedEffect(uiState.transcript.size, uiState.livePartialText) {
        val itemCount = uiState.transcript.size + if (uiState.livePartialText.isNotBlank()) 1 else 0
        if (itemCount > 0) {
            coroutineScope.launch { listState.animateScrollToItem(itemCount - 1) }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("RacingAgents") },
                actions = {
                    IconButton(onClick = { viewModel.openSettingsSheet() }) {
                        Icon(Icons.Filled.Settings, contentDescription = "設定")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                text = { Text("AI解析") },
                icon = {},
                onClick = { viewModel.runAnalysis() },
            )
        },
    ) { padding ->
        // Split screen per user request: transcript (top half) above the AI解析 panel (bottom
        // half), instead of the analysis result being a modal sheet that covers everything and
        // hides what's happening. The transcript half is collapsible (like the web viewer's
        // accordion) — collapsing it frees that space for the analysis panels, which switch from
        // side-by-side columns to a single stacked column so each gets the freed width too.
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            Column(modifier = Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AssistChip(onClick = {}, label = { Text(uiState.statusChipText()) })
                        val currentSessionId = uiState.sessionId
                        if (currentSessionId != null) {
                            Spacer(Modifier.width(8.dp))
                            val context = androidx.compose.ui.platform.LocalContext.current
                            AssistChip(
                                onClick = {
                                    val url = viewerUrl(uiState.settings.serverUrl, currentSessionId)
                                    copyToClipboard(context, url)
                                    android.widget.Toast.makeText(context, "ビュワーURLをコピーしました", android.widget.Toast.LENGTH_SHORT).show()
                                },
                                label = { Text("👁 共有") },
                            )
                        }
                    }
                    Spacer(Modifier.height(0.dp))
                    Row {
                        Button(onClick = {
                            onRequestPermissions()
                            if (uiState.listeningState == com.example.racingagents.stt.ListeningState.IDLE) {
                                viewModel.startListening()
                            } else {
                                viewModel.stopListening()
                            }
                        }) {
                            val isListening = uiState.listeningState != com.example.racingagents.stt.ListeningState.IDLE
                            Text(if (isListening) "Stop" else "Start")
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (uiState.sessionId != null) {
                        AssistChip(
                            onClick = { showInstructionDialog = true },
                            label = { Text("📝 メモを添えて解析") },
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    AssistChip(
                        onClick = { showNewSessionConfirm = true },
                        label = { Text("🆕 新規セッション") },
                    )
                }

                if (uiState.lastErrorMessage != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "⚠ ${uiState.lastErrorMessage}",
                        color = androidx.compose.material3.MaterialTheme.colorScheme.error,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                Spacer(Modifier.height(12.dp))

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { transcriptExpanded = !transcriptExpanded },
                ) {
                    Text(if (transcriptExpanded) "▾" else "▸")
                    Spacer(Modifier.width(4.dp))
                    Text("文字起こし", style = androidx.compose.material3.MaterialTheme.typography.labelLarge)
                }
            }

            if (transcriptExpanded) {
                LazyColumn(state = listState, modifier = Modifier.weight(1f).padding(horizontal = 16.dp)) {
                    items(uiState.transcript, key = { it.localId }) { line ->
                        // Synced (server-confirmed) lines render in full-strength text color;
                        // still-pending lines render gray so upload status is visible at a glance.
                        // Archived (AI解析から除外) lines additionally get strikethrough + italic.
                        Row(
                            verticalAlignment = Alignment.Top,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp)
                                .pointerInput(line.localId) {
                                    detectTapGestures(onLongPress = {
                                        if (line.synced) editingLine = line
                                    })
                                },
                        ) {
                            Text(
                                text = transcriptTimeFormat.format(java.util.Date(line.recognizedAt)),
                                color = Color.Gray,
                                style = androidx.compose.material3.MaterialTheme.typography.labelSmall,
                                modifier = Modifier.padding(end = 8.dp, top = 2.dp),
                            )
                            Text(
                                text = if (line.excluded) "🗄 ${line.text}" else line.text,
                                color = if (line.synced) {
                                    androidx.compose.material3.MaterialTheme.colorScheme.onSurface
                                } else {
                                    Color.Gray
                                },
                                textDecoration = if (line.excluded) TextDecoration.LineThrough else null,
                                fontStyle = if (line.excluded) FontStyle.Italic else null,
                            )
                        }
                    }
                    if (uiState.livePartialText.isNotBlank()) {
                        item {
                            Text(
                                text = uiState.livePartialText,
                                color = Color.Gray,
                                modifier = Modifier.padding(vertical = 4.dp),
                            )
                        }
                    }
                }
            }

            HorizontalDivider()

            // 手動解析と自動解析（間隔/文字数トリガー）は通常別カラムで並べ、自動実行が
            // 手動のタイムラインに割り込んで見づらくならないようにする。ただし文字起こしを
            // 畳んだときは、空いた幅を活かして縦積みの1カラムに切り替える。
            val manualLabel = "手動解析"
            val autoLabel = "自動解析" + if (uiState.settings.autoAnalysisEnabled) "" else "（無効）"
            val manualPanel: @Composable (Modifier) -> Unit = { mod ->
                AnalysisPanel(
                    analysisHistory = uiState.analysisHistory.filter { it.trigger == AnalysisTrigger.MANUAL },
                    modifier = mod,
                )
            }
            val autoPanel: @Composable (Modifier) -> Unit = { mod ->
                AnalysisPanel(
                    analysisHistory = uiState.analysisHistory.filter { it.trigger == AnalysisTrigger.AUTO },
                    modifier = mod,
                )
            }

            if (transcriptExpanded) {
                Row(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            manualLabel,
                            style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                            modifier = Modifier.padding(start = 16.dp, top = 8.dp),
                        )
                        manualPanel(Modifier.weight(1f))
                    }
                    androidx.compose.material3.VerticalDivider()
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            autoLabel,
                            style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                            modifier = Modifier.padding(start = 16.dp, top = 8.dp),
                        )
                        autoPanel(Modifier.weight(1f))
                    }
                }
            } else {
                Column(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    Text(
                        manualLabel,
                        style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                        modifier = Modifier.padding(start = 16.dp, top = 8.dp),
                    )
                    manualPanel(Modifier.weight(1f))
                    HorizontalDivider()
                    Text(
                        autoLabel,
                        style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                        modifier = Modifier.padding(start = 16.dp, top = 8.dp),
                    )
                    autoPanel(Modifier.weight(1f))
                }
            }
        }
    }

    if (uiState.showSettingsSheet) {
        SettingsSheet(
            settings = uiState.settings,
            onServerUrlChanged = viewModel::onServerUrlChanged,
            onApiKeyChanged = viewModel::onApiKeyChanged,
            onMuteBeepChanged = viewModel::onMuteBeepChanged,
            onAutoAnalysisEnabledChanged = viewModel::onAutoAnalysisEnabledChanged,
            onAutoAnalysisIntervalChanged = viewModel::onAutoAnalysisIntervalChanged,
            onAutoAnalysisCharThresholdChanged = viewModel::onAutoAnalysisCharThresholdChanged,
            onAnalysisModeChanged = viewModel::onAnalysisModeChanged,
            onDismiss = { viewModel.closeSettingsSheet() },
        )
    }

    editingLine?.let { line ->
        EditLineDialog(
            line = line,
            onSave = { newText, excluded ->
                viewModel.updateTranscriptLine(line.clientSeq, newText = newText, excluded = excluded)
                editingLine = null
            },
            onDismiss = { editingLine = null },
        )
    }

    if (showInstructionDialog) {
        InstructionDialog(
            onSubmit = { instruction ->
                viewModel.runAnalysis(instruction = instruction)
                showInstructionDialog = false
            },
            onDismiss = { showInstructionDialog = false },
        )
    }

    if (showNewSessionConfirm) {
        AlertDialog(
            onDismissRequest = { showNewSessionConfirm = false },
            title = { Text("新規セッションを開始しますか？") },
            text = { Text("現在の文字起こし・解析結果の表示はクリアされます（サーバー上の過去データは残ります）。") },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.startNewSession()
                    showNewSessionConfirm = false
                }) { Text("開始する") }
            },
            dismissButton = {
                TextButton(onClick = { showNewSessionConfirm = false }) { Text("キャンセル") }
            },
        )
    }
}

/** Opened via the "📝 メモを添えて解析" chip: attach a free-text note (context the STT missed, a
 * specific question) to a single manual AI解析 run. */
@Composable
private fun InstructionDialog(
    onSubmit: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var text by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("メモを添えて解析") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text("AIに伝えたいこと（任意）") },
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(onClick = { onSubmit(text) }) { Text("解析する") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("キャンセル") }
        },
    )
}

/** Long-press-triggered dialog: correct STT mistakes and/or archive a line out of AI解析 context. */
@Composable
private fun EditLineDialog(
    line: TranscriptLine,
    onSave: (text: String, excluded: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    var text by remember(line.localId) { mutableStateOf(line.text) }
    var excluded by remember(line.localId) { mutableStateOf(line.excluded) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("行を編集") },
        text = {
            Column {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text("テキスト") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("AI解析から除外（アーカイブ）")
                    Switch(checked = excluded, onCheckedChange = { excluded = it })
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(text, excluded) }) { Text("保存") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("キャンセル") }
        },
    )
}

/** Strips whitespace, markdown emphasis markers, and control characters that pasted text
 * (e.g. from a chat message) commonly carries alongside a URL. */
private fun sanitizeUrlInput(raw: String): String =
    raw.trim().filterNot { c -> c == '\n' || c == '\r' || c == '*' || c == '`' || c.isWhitespace() }

/** Builds a shareable read-only viewer link for the currently active session, so someone
 * watching on a laptop/tablet can follow along without controlling the phone. */
private fun viewerUrl(serverUrl: String, sessionId: String): String {
    val base = if (serverUrl.endsWith("/")) serverUrl.dropLast(1) else serverUrl
    return "$base/viewer.html?session=$sessionId"
}

private fun copyToClipboard(context: android.content.Context, text: String) {
    val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("viewer_url", text))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSheet(
    settings: com.example.racingagents.data.AppSettings,
    onServerUrlChanged: (String) -> Unit,
    onApiKeyChanged: (String) -> Unit,
    onMuteBeepChanged: (Boolean) -> Unit,
    onAutoAnalysisEnabledChanged: (Boolean) -> Unit,
    onAutoAnalysisIntervalChanged: (Int) -> Unit,
    onAutoAnalysisCharThresholdChanged: (Int) -> Unit,
    onAnalysisModeChanged: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Text("サーバー設定")
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = settings.serverUrl,
                onValueChange = { onServerUrlChanged(sanitizeUrlInput(it)) },
                label = { Text("サーバーURL (例: http://mac.tailxxxx.ts.net:8787)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = settings.apiKey,
                onValueChange = { onApiKeyChanged(it.filterNot { c -> c == '\n' || c == '\r' }) },
                label = { Text("APIキー") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Text("再起動ビープを消音（実機要確認）")
                Switch(checked = settings.muteRestartBeep, onCheckedChange = onMuteBeepChanged)
            }

            Spacer(Modifier.height(16.dp))
            HorizontalDivider()
            Spacer(Modifier.height(8.dp))
            Text("自動解析")
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Text("有効化（右側カラムに自動で溜まる）")
                Switch(checked = settings.autoAnalysisEnabled, onCheckedChange = onAutoAnalysisEnabledChanged)
            }
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = settings.autoAnalysisIntervalSec.toString(),
                onValueChange = { onAutoAnalysisIntervalChanged(it.toIntOrNull() ?: 0) },
                label = { Text("間隔（秒、0で無効）") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = settings.autoAnalysisCharThreshold.toString(),
                onValueChange = { onAutoAnalysisCharThresholdChanged(it.toIntOrNull() ?: 0) },
                label = { Text("文字数しきい値（0で無効）") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "間隔・文字数のどちらかを満たし、かつ前回から新しい発言があると自動解析します。",
                style = androidx.compose.material3.MaterialTheme.typography.labelSmall,
                color = Color.Gray,
            )

            Spacer(Modifier.height(16.dp))
            HorizontalDivider()
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text("ピットウォールモード")
                    Text(
                        if (settings.analysisMode == "pitwall") "ピットウォール" else "通常解析",
                        style = androidx.compose.material3.MaterialTheme.typography.labelSmall,
                        color = Color.Gray,
                    )
                }
                Switch(
                    checked = settings.analysisMode == "pitwall",
                    onCheckedChange = { onAnalysisModeChanged(if (it) "pitwall" else "default") },
                )
            }
        }
    }
}
