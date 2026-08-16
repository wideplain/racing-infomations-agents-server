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
