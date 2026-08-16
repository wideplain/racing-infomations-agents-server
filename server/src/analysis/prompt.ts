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

export interface PitwallDecision {
  createdAt: string;
  proposal: string;
  statusSummary: string;
}

export interface PromptSegment {
  clientSeq: number;
  text: string;
  createdAt: string;
}

export const DEFAULT_MAX_SEGMENTS = 40;
export const DEFAULT_MAX_CHARS = 8000;

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

function formatDecisionTimestamp(createdAt: string): string {
  const d = new Date(createdAt);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `[${hh}:${mm}]`;
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
