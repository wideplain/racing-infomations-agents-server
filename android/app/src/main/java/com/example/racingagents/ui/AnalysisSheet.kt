package com.example.racingagents.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.JAPAN)

/** Bottom half of the split-screen layout: a timestamped timeline of AI解析 runs, newest at the
 * bottom (like a log), always visible (no modal) so multiple analyses accumulate instead of
 * overwriting each other. */
@Composable
fun AnalysisPanel(
    analysisHistory: List<AnalysisEntry>,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()

    // Re-scroll not just when a new entry is appended, but whenever the newest entry's content
    // grows (QUEUED -> RUNNING -> DONE streams in more text) — keying on size alone would miss
    // those in-place updates and leave the view stuck once a long result overflows the panel.
    val last = analysisHistory.lastOrNull()
    val scrollSignature = last?.let { "${it.localId}:${it.status}:${it.result?.result?.summary?.length ?: 0}" }
    LaunchedEffect(scrollSignature) {
        if (analysisHistory.isNotEmpty()) {
            coroutineScope.launch { listState.animateScrollToItem(analysisHistory.size - 1) }
        }
    }

    if (analysisHistory.isEmpty()) {
        Column(modifier = modifier.fillMaxWidth().padding(16.dp)) {
            Text("解析を開始していません")
        }
        return
    }

    LazyColumn(state = listState, modifier = modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        items(analysisHistory, key = { it.localId }) { entry ->
            AnalysisEntryCard(entry)
            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
        }
    }
}

@Composable
private fun AnalysisEntryCard(entry: AnalysisEntry) {
    val context = LocalContext.current
    var showRaw by remember(entry.localId) { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(
            text = timeFormat.format(Date(entry.requestedAt)),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
        )
        if (!entry.instruction.isNullOrBlank()) {
            Text(
                text = "📝 ${entry.instruction}",
                style = MaterialTheme.typography.bodySmall,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
            )
        }
        Spacer(Modifier.height(4.dp))

        when (entry.status) {
            AnalysisStatus.QUEUED -> LoadingRow("解析待ち…")
            AnalysisStatus.RUNNING -> LoadingRow("解析中…")
            AnalysisStatus.ERROR -> Text("エラー: ${entry.errorMessage ?: "不明なエラー"}")
            AnalysisStatus.DONE -> {
                val result = entry.result?.result
                if (result == null) {
                    Text("結果がありません")
                } else if (result.statusSummary != null) {
                    // Pitwall-mode result: race-radio style sections instead of the default ones.
                    SectionTitle("状況")
                    Text(result.statusSummary)
                    Spacer(Modifier.height(8.dp))
                    SectionTitle("変化")
                    Text(result.change ?: "-")
                    Spacer(Modifier.height(8.dp))
                    SectionTitle("確認質問")
                    Text(result.question ?: "-")
                    Spacer(Modifier.height(8.dp))
                    SectionTitle("提案")
                    Text(
                        if (result.needsReview == true) "⚠ 要確認: ${result.proposal ?: "-"}" else result.proposal ?: "-",
                    )
                    Spacer(Modifier.height(8.dp))
                    SectionTitle("根拠事実")
                    result.facts.forEach { Text("・$it") }
                    if (result.warnings.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        SectionTitle("警告")
                        result.warnings.forEach {
                            Text("・$it", color = MaterialTheme.colorScheme.error)
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    androidx.compose.material3.AssistChip(
                        onClick = {},
                        label = { Text("信頼度: ${result.confidenceText()}") },
                    )
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = { copyToClipboard(context, buildCopyText(result)) }) {
                        Text("コピー")
                    }
                    Row {
                        Text("raw JSONを表示")
                        Switch(checked = showRaw, onCheckedChange = { showRaw = it })
                    }
                    if (showRaw) {
                        val rawJson = entry.result.let {
                            runCatching { Json { prettyPrint = true }.encodeToString(it) }.getOrNull()
                        } ?: "-"
                        Text(rawJson)
                    }
                } else {
                    SectionTitle("要約")
                    Text(result.summary ?: "-")
                    Spacer(Modifier.height(8.dp))
                    SectionTitle("解釈")
                    Text(result.interpretation ?: "-")
                    Spacer(Modifier.height(8.dp))
                    SectionTitle("アドバイス")
                    result.advice.forEach { Text("・$it") }
                    Spacer(Modifier.height(8.dp))
                    SectionTitle("返答案")
                    Text(result.suggestedResponse ?: "-")
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = { copyToClipboard(context, buildCopyText(result)) }) {
                        Text("コピー")
                    }
                    Row {
                        Text("raw JSONを表示")
                        Switch(checked = showRaw, onCheckedChange = { showRaw = it })
                    }
                    if (showRaw) {
                        val rawJson = entry.result.let {
                            runCatching { Json { prettyPrint = true }.encodeToString(it) }.getOrNull()
                        } ?: "-"
                        Text(rawJson)
                    }
                }
            }
        }
    }
}

@Composable
private fun LoadingRow(label: String) {
    Row {
        CircularProgressIndicator(modifier = Modifier.height(16.dp))
        Spacer(Modifier.height(0.dp))
        Text(label, modifier = Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, fontWeight = FontWeight.Bold)
}

private fun buildCopyText(result: com.example.racingagents.net.AnalysisResultDto): String = buildString {
    if (result.statusSummary != null) {
        appendLine("状況: ${result.statusSummary}")
        appendLine("変化: ${result.change ?: "-"}")
        appendLine("確認質問: ${result.question ?: "-"}")
        appendLine("提案: ${if (result.needsReview == true) "⚠ 要確認: " else ""}${result.proposal ?: "-"}")
        appendLine("根拠事実:")
        result.facts.forEach { appendLine("・$it") }
        if (result.warnings.isNotEmpty()) {
            appendLine("警告:")
            result.warnings.forEach { appendLine("・$it") }
        }
        appendLine("信頼度: ${result.confidenceText()}")
    } else {
        appendLine("要約: ${result.summary ?: "-"}")
        appendLine("解釈: ${result.interpretation ?: "-"}")
        appendLine("アドバイス:")
        result.advice.forEach { appendLine("・$it") }
        appendLine("返答案: ${result.suggestedResponse ?: "-"}")
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("analysis", text))
}
