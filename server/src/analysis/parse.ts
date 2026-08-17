import { z } from "zod";

const analysisSchema = z.object({
  summary: z.string().nullable().default(null),
  interpretation: z.string().nullable().default(null),
  advice: z.array(z.string()).nullable().default(null),
  suggested_response: z.string().nullable().default(null),
  confidence: z.number().nullable().default(null),
  notes: z.string().nullable().default(null),
});

export interface ParsedAnalysis {
  summary: string;
  interpretation: string;
  advice: string[];
  suggested_response: string;
  confidence: number | null;
  notes: string | null;
  parseFallback: boolean;
}

function tryDirectJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function tryFenceStrip(text: string): unknown | undefined {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return undefined;
  }
}

function tryOutermostBraces(text: string): unknown | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function fillFromZod(candidate: unknown): ParsedAnalysis | undefined {
  const parsed = analysisSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const d = parsed.data;
  return {
    summary: d.summary ?? "",
    interpretation: d.interpretation ?? "",
    advice: d.advice ?? [],
    suggested_response: d.suggested_response ?? "",
    confidence: d.confidence ?? null,
    notes: d.notes ?? null,
    parseFallback: false,
  };
}

/**
 * Fallback chain: JSON.parse -> code-fence strip -> outermost {..} extraction
 * -> zod validation with null-fill -> raw-text summary fallback (parseFallback: true).
 * Always returns a displayable result; never throws.
 */
export function parseAnalysis(rawText: string): ParsedAnalysis {
  const candidates = [
    tryDirectJson(rawText),
    tryFenceStrip(rawText),
    tryOutermostBraces(rawText),
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const filled = fillFromZod(candidate);
    if (filled) return filled;
  }

  return {
    summary: rawText.trim(),
    interpretation: "",
    advice: [],
    suggested_response: "",
    confidence: null,
    notes: null,
    parseFallback: true,
  };
}

const pitwallSchema = z.object({
  statusSummary: z.string().nullable().default(null),
  change: z.string().nullable().default(null),
  question: z.string().nullable().default(null),
  proposal: z.string().nullable().default(null),
  confidence: z.enum(["low", "medium", "high"]).nullable().default(null),
  needsReview: z.boolean().nullable().default(null),
  facts: z.array(z.string()).nullable().default(null),
  warnings: z.array(z.string()).nullable().default(null),
});

export interface ParsedPitwallAnalysis {
  statusSummary: string;
  change: string;
  question: string;
  proposal: string;
  confidence: "low" | "medium" | "high" | null;
  needsReview: boolean;
  facts: string[];
  warnings: string[];
  parseFallback: boolean;
}

function fillPitwallFromZod(candidate: unknown): ParsedPitwallAnalysis | undefined {
  const parsed = pitwallSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const d = parsed.data;
  return {
    statusSummary: d.statusSummary ?? "",
    change: d.change ?? "",
    question: d.question ?? "",
    proposal: d.proposal ?? "",
    confidence: d.confidence ?? null,
    needsReview: d.needsReview ?? false,
    facts: d.facts ?? [],
    warnings: d.warnings ?? [],
    parseFallback: false,
  };
}

/**
 * Same fallback chain as parseAnalysis: JSON.parse -> code-fence strip ->
 * outermost {..} extraction -> zod validation with null-fill -> raw-text
 * fallback (parseFallback: true).
 */
export function parsePitwallAnalysis(rawText: string): ParsedPitwallAnalysis {
  const candidates = [
    tryDirectJson(rawText),
    tryFenceStrip(rawText),
    tryOutermostBraces(rawText),
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const filled = fillPitwallFromZod(candidate);
    if (filled) return filled;
  }

  return {
    statusSummary: rawText.trim(),
    change: "",
    question: "",
    proposal: "",
    confidence: null,
    needsReview: false,
    facts: [],
    warnings: [],
    parseFallback: true,
  };
}

const questionSchema = z.object({
  answer: z.string().nullable().default(null),
  basedOn: z
    .array(
      z.object({
        at: z.string().nullable().default(null),
        quote: z.string().nullable().default(null),
      })
    )
    .nullable()
    .default(null),
  confidence: z.enum(["low", "medium", "high"]).nullable().default(null),
  unknown: z.array(z.string()).nullable().default(null),
});

export interface QuestionEvidence {
  /** The transcript's elapsed "mm:ss" stamp, as the model emitted it. */
  at: string;
  /** [at] resolved against the session start, or null when it wasn't a readable mm:ss. */
  clock: string | null;
  quote: string;
}

export interface ParsedQuestionAnalysis {
  answer: string;
  basedOn: QuestionEvidence[];
  confidence: "low" | "medium" | "high" | null;
  unknown: string[];
  parseFallback: boolean;
}

/** The model is asked for elapsed "mm:ss" because that is what the transcript it reads is
 * stamped with; a crew member checking the claim against the viewer's log wants a wall clock.
 * Resolving it here means all three clients (viewer, テキストテスト page, Android) just print
 * the string instead of each reimplementing the arithmetic.
 *
 * [transcriptStamps] is the set of stamps that actually appeared in the prompt, and a citation
 * outside it resolves to null rather than to a time. Arithmetic alone would happily turn a
 * hallucinated "07:15", or a wall-clock time copied out of the prior-records block, into an
 * exact-looking HH:MM:SS — and basedOn exists precisely so a crew member can check a claim before
 * relaying it to a driver at speed. An unresolved stamp is a useful warning; a fabricated one is
 * the failure this mode is built to avoid. */
function toWallClock(
  at: string,
  sessionStartedAt: string,
  transcriptStamps: ReadonlySet<string>
): string | null {
  const match = at.trim().match(/^\[?(\d{1,4}):([0-5]\d)\]?$/);
  if (!match) return null;
  // buildTranscript zero-pads minutes to two digits, so "5:07" and "05:07" are the same line.
  if (!transcriptStamps.has(`${match[1].padStart(2, "0")}:${match[2]}`)) return null;
  const startedMs = new Date(sessionStartedAt).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const elapsedMs = (Number(match[1]) * 60 + Number(match[2])) * 1000;
  const d = new Date(startedMs + elapsedMs);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function fillQuestionFromZod(
  candidate: unknown,
  sessionStartedAt: string,
  transcriptStamps: ReadonlySet<string>
): ParsedQuestionAnalysis | undefined {
  const parsed = questionSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const d = parsed.data;
  return {
    answer: d.answer ?? "",
    basedOn: (d.basedOn ?? []).map((e) => {
      const at = e.at ?? "";
      return {
        at,
        clock: toWallClock(at, sessionStartedAt, transcriptStamps),
        quote: e.quote ?? "",
      };
    }),
    confidence: d.confidence ?? null,
    unknown: d.unknown ?? [],
    parseFallback: false,
  };
}

/**
 * Same fallback chain as the other parsers: JSON.parse -> code-fence strip -> outermost {..}
 * extraction -> zod validation with null-fill -> raw-text fallback (parseFallback: true).
 * [sessionStartedAt] and [transcriptStamps] are only used to resolve each basedOn entry's mm:ss
 * into a wall clock — see toWallClock for why an unrecognised stamp stays unresolved.
 */
export function parseQuestionAnalysis(
  rawText: string,
  sessionStartedAt: string,
  transcriptStamps: ReadonlySet<string>
): ParsedQuestionAnalysis {
  const candidates = [
    tryDirectJson(rawText),
    tryFenceStrip(rawText),
    tryOutermostBraces(rawText),
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const filled = fillQuestionFromZod(candidate, sessionStartedAt, transcriptStamps);
    if (filled) return filled;
  }

  return {
    answer: rawText.trim(),
    basedOn: [],
    confidence: null,
    unknown: [],
    parseFallback: true,
  };
}

const driverSchema = z.object({
  headline: z.string().nullable().default(null),
  action: z.string().nullable().default(null),
  watch: z.string().nullable().default(null),
  urgency: z.enum(["low", "medium", "high"]).nullable().default(null),
});

export interface ParsedDriverAnalysis {
  headline: string;
  action: string;
  watch: string | null;
  urgency: "low" | "medium" | "high" | null;
  parseFallback: boolean;
}

// The driver HUD renders these fields in huge fonts on a small phone
// screen; the model may overshoot the 16-character instruction, so we
// hard-truncate here regardless of what came back.
const DRIVER_FIELD_MAX_CHARS = 16;

function truncateDriverField(value: string): string {
  return value.slice(0, DRIVER_FIELD_MAX_CHARS);
}

function fillDriverFromZod(candidate: unknown): ParsedDriverAnalysis | undefined {
  const parsed = driverSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const d = parsed.data;
  return {
    headline: truncateDriverField(d.headline ?? ""),
    action: truncateDriverField(d.action ?? ""),
    watch: d.watch != null ? truncateDriverField(d.watch) : null,
    urgency: d.urgency ?? null,
    parseFallback: false,
  };
}

/**
 * Same fallback chain as parseAnalysis/parsePitwallAnalysis: JSON.parse ->
 * code-fence strip -> outermost {..} extraction -> zod validation with
 * null-fill -> raw-text fallback (parseFallback: true). All string fields
 * are hard-truncated to 16 characters after parsing.
 */
export function parseDriverAnalysis(rawText: string): ParsedDriverAnalysis {
  const candidates = [
    tryDirectJson(rawText),
    tryFenceStrip(rawText),
    tryOutermostBraces(rawText),
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const filled = fillDriverFromZod(candidate);
    if (filled) return filled;
  }

  return {
    headline: truncateDriverField(rawText.trim()),
    action: "",
    watch: null,
    urgency: null,
    parseFallback: true,
  };
}
