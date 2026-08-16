export interface AnalyzeInput {
  prompt: string;
  /** Optional path to a JSON schema for `codex exec --output-schema`; defaults to the analysis schema. */
  schemaPath?: string;
}

export interface AnalyzeOutput {
  summary: string;
  interpretation: string;
  advice: string[];
  suggested_response: string;
  confidence: number | null;
  notes: string | null;
  parseFallback: boolean;
  rawOutput: string;
  durationMs: number;
}

export interface AIProvider {
  name: string;
  analyze(input: AnalyzeInput): Promise<AnalyzeOutput>;
  healthcheck(): Promise<boolean>;
}
