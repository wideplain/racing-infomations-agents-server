import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE_PATH = join(__dirname, "..", "..", "prompts", "analyze.ja.md");
const PITWALL_PROMPT_TEMPLATE_PATH = join(
  __dirname,
  "..",
  "..",
  "prompts",
  "pitwall.ja.md"
);
const DRIVER_PROMPT_TEMPLATE_PATH = join(
  __dirname,
  "..",
  "..",
  "prompts",
  "driver.ja.md"
);
const QUESTION_PROMPT_TEMPLATE_PATH = join(
  __dirname,
  "..",
  "..",
  "prompts",
  "question.ja.md"
);

export interface PitwallDecision {
  createdAt: string;
  proposal: string;
  statusSummary: string;
}

/** One prior analysis rendered into question mode's "{{DECISIONS}}" block. Unlike the other
 * modes, question mode mixes several modes into one list, so each entry carries the label that
 * says which mode produced it. */
export interface PriorRecord {
  createdAt: string;
  label: string;
  text: string;
}

export interface PromptSegment {
  clientSeq: number;
  text: string;
  createdAt: string;
}

export const DEFAULT_MAX_SEGMENTS = 40;
export const DEFAULT_MAX_CHARS = 8000;

// The reporting modes only ever need the recent past, so a small window keeps them cheap. A
// question is the opposite: "何分頃にタイヤの話をしていた？" is asked precisely about something
// that has already scrolled out of the reporting window, and answering "記録にありません" when
// the line is sitting in the database is the worst way for this mode to fail.
export const QUESTION_MAX_SEGMENTS = 400;
export const QUESTION_MAX_CHARS = 40000;

function formatTimestamp(createdAt: string, baseAt: string): string {
  const elapsedMs = Math.max(
    0,
    new Date(createdAt).getTime() - new Date(baseAt).getTime()
  );
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (totalSeconds % 60).toString().padStart(2, "0");
  return `[${mm}:${ss}]`;
}

/**
 * Takes the tail `maxSegments` segments, formats as "[mm:ss] text" lines,
 * then trims from the front (oldest) until under `maxChars` total.
 */
export function buildTranscript(
  segments: PromptSegment[],
  sessionStartedAt: string,
  maxSegments = DEFAULT_MAX_SEGMENTS,
  maxChars = DEFAULT_MAX_CHARS
): string {
  const tail = segments.slice(-maxSegments);
  const lines = tail.map(
    (seg) => `${formatTimestamp(seg.createdAt, sessionStartedAt)} ${seg.text}`
  );

  let joined = lines.join("\n");
  while (joined.length > maxChars && lines.length > 1) {
    lines.shift();
    joined = lines.join("\n");
  }
  // If even a single line exceeds maxChars, truncate it from the front.
  if (joined.length > maxChars) {
    joined = joined.slice(joined.length - maxChars);
  }
  return joined;
}

export function loadPromptTemplate(path: string = PROMPT_TEMPLATE_PATH): string {
  return readFileSync(path, "utf-8");
}

export function loadPitwallPromptTemplate(
  path: string = PITWALL_PROMPT_TEMPLATE_PATH
): string {
  return readFileSync(path, "utf-8");
}

export function loadDriverPromptTemplate(
  path: string = DRIVER_PROMPT_TEMPLATE_PATH
): string {
  return readFileSync(path, "utf-8");
}

export function loadQuestionPromptTemplate(
  path: string = QUESTION_PROMPT_TEMPLATE_PATH
): string {
  return readFileSync(path, "utf-8");
}

function formatWallClock(createdAt: string): string {
  const d = new Date(createdAt);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatDecisionTimestamp(createdAt: string): string {
  return `[${formatWallClock(createdAt)}]`;
}

/** Formats prior pitwall analyses into "{{DECISIONS}}" lines, newest first as given. */
export function buildDecisions(decisions: PitwallDecision[]): string {
  if (decisions.length === 0) return "なし";
  return decisions
    .map(
      (d) =>
        `${formatDecisionTimestamp(d.createdAt)} 提案: ${d.proposal} / 状況: ${d.statusSummary}`
    )
    .join("\n");
}

/** Formats prior analyses of mixed modes into question mode's "{{DECISIONS}}" lines.
 *
 * The timestamp deliberately sits *inside* the label parentheses instead of leading the line in
 * brackets the way buildDecisions writes it. These are wall-clock times, while the transcript
 * above them is stamped with bracketed elapsed [mm:ss]; two different clocks in the same visual
 * notation invites the model to cite a record's time as if it were a transcript position, and
 * question mode's whole promise is that a cited time can be looked up in the log. */
export function buildPriorRecords(records: PriorRecord[]): string {
  if (records.length === 0) return "なし";
  return records
    .map((r) => `(${r.label} ${formatWallClock(r.createdAt)}) ${r.text}`)
    .join("\n");
}

/** Every bracketed elapsed stamp present in a built prompt's transcript block. Used to check a
 * model's basedOn citation against lines that actually exist — see toWallClock in parse.ts.
 * Anchored to line start, which is why buildPriorRecords must not emit leading brackets. */
export function transcriptStamps(prompt: string): Set<string> {
  const stamps = new Set<string>();
  for (const match of prompt.matchAll(/^\[(\d{1,4}:[0-5]\d)\]/gm)) {
    stamps.add(match[1]);
  }
  return stamps;
}

/** Renders the optional free-text instruction a user attaches to a single manual analysis run. */
function formatInstruction(instruction: string | undefined): string {
  const trimmed = instruction?.trim();
  return trimmed ? trimmed : "なし";
}

export function buildPitwallPrompt(
  segments: PromptSegment[],
  sessionStartedAt: string,
  decisions: PitwallDecision[],
  opts: {
    maxSegments?: number;
    maxChars?: number;
    template?: string;
    instruction?: string;
  } = {}
): string {
  const template = opts.template ?? loadPitwallPromptTemplate();
  const transcript = buildTranscript(
    segments,
    sessionStartedAt,
    opts.maxSegments,
    opts.maxChars
  );
  return template
    .replace("{{TRANSCRIPT}}", transcript)
    .replace("{{DECISIONS}}", buildDecisions(decisions))
    .replace("{{INSTRUCTION}}", formatInstruction(opts.instruction));
}

export function buildDriverPrompt(
  segments: PromptSegment[],
  sessionStartedAt: string,
  decisions: PitwallDecision[],
  opts: {
    maxSegments?: number;
    maxChars?: number;
    template?: string;
    instruction?: string;
  } = {}
): string {
  const template = opts.template ?? loadDriverPromptTemplate();
  const transcript = buildTranscript(
    segments,
    sessionStartedAt,
    opts.maxSegments,
    opts.maxChars
  );
  return template
    .replace("{{TRANSCRIPT}}", transcript)
    .replace("{{DECISIONS}}", buildDecisions(decisions))
    .replace("{{INSTRUCTION}}", formatInstruction(opts.instruction));
}

/** The crew's question goes into {{QUESTION}} rather than {{INSTRUCTION}}: in the other modes an
 * instruction is an optional aside to a report that would run anyway, whereas here it is the
 * whole point of the run. Defaults to the wider transcript window — see QUESTION_MAX_SEGMENTS. */
export function buildQuestionPrompt(
  segments: PromptSegment[],
  sessionStartedAt: string,
  records: PriorRecord[],
  opts: {
    maxSegments?: number;
    maxChars?: number;
    template?: string;
    question: string;
  }
): string {
  const template = opts.template ?? loadQuestionPromptTemplate();
  const transcript = buildTranscript(
    segments,
    sessionStartedAt,
    opts.maxSegments ?? QUESTION_MAX_SEGMENTS,
    opts.maxChars ?? QUESTION_MAX_CHARS
  );
  // The other modes report on the recent past, so dropping older lines costs them nothing. This
  // mode is told to treat the log as the complete basis and to answer 「記録にありません」 for
  // anything absent from it — so an unannounced truncation turns a real recorded fact into a
  // confident denial. Say out loud that the window was cut rather than letting it look complete.
  const full = buildTranscript(segments, sessionStartedAt, Infinity, Infinity);
  const body =
    transcript === full
      ? transcript
      : `（注意: これ以前の発言はこのプロンプトに含まれていません。含まれていない範囲については「記録にありません」ではなく、「この抜粋の範囲では確認できません」と答えてください）\n${transcript}`;
  // Replacement *functions* rather than strings: String.replace reads "$&", "$'" and "$`" in a
  // replacement string as insertion patterns, and every value substituted here is text a human
  // typed or spoke. A question containing one of those would otherwise be silently rewritten.
  return template
    .replace("{{TRANSCRIPT}}", () => body)
    .replace("{{DECISIONS}}", () => buildPriorRecords(records))
    .replace("{{QUESTION}}", () => opts.question.trim());
}

export function buildPrompt(
  segments: PromptSegment[],
  sessionStartedAt: string,
  opts: {
    maxSegments?: number;
    maxChars?: number;
    template?: string;
    instruction?: string;
  } = {}
): string {
  const template = opts.template ?? loadPromptTemplate();
  const transcript = buildTranscript(
    segments,
    sessionStartedAt,
    opts.maxSegments,
    opts.maxChars
  );
  return template
    .replace("{{TRANSCRIPT}}", transcript)
    .replace("{{INSTRUCTION}}", formatInstruction(opts.instruction));
}
