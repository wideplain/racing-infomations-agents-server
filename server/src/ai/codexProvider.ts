import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AIProvider, AnalyzeInput, AnalyzeOutput } from "./types.js";
import { parseAnalysis } from "../analysis/parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, "..", "..");
const SCRATCH_DIR = join(SERVER_ROOT, "scratch");
const SCHEMA_PATH = join(SERVER_ROOT, "schemas", "analysis.schema.json");
export const PITWALL_SCHEMA_PATH = join(SERVER_ROOT, "schemas", "pitwall.schema.json");
export const DRIVER_SCHEMA_PATH = join(SERVER_ROOT, "schemas", "driver.schema.json");

export interface CodexProviderOptions {
  codexBin?: string;
  timeoutMs?: number;
  codexHome?: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCodexOnce(
  prompt: string,
  codexBin: string,
  timeoutMs: number,
  codexHome: string | undefined,
  schemaPath: string
): Promise<{ run: RunResult; outputLastMessagePath: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "codex-out-"));
  const outputLastMessagePath = join(tmpDir, "last-message.txt");

  const args = [
    "exec",
    "--cd",
    SCRATCH_DIR,
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--color",
    "never",
    "-c",
    'approval_policy="never"',
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputLastMessagePath,
    "-",
  ];

  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NO_COLOR: "1",
    };
    if (codexHome) env.CODEX_HOME = codexHome;
    else if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;

    // detached: true puts the child in its own process group so that on
    // timeout we can signal the whole group (e.g. codex + any subprocess
    // it spawns). Signaling only the direct child can leave a foreground
    // grandchild (like a shell's `sleep`) alive, since some shells defer
    // signal delivery until their current foreground job exits.
    const child = spawn(codexBin, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const signalGroup = (sig: NodeJS.Signals) => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // process already gone
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      setTimeout(() => {
        if (!settled) signalGroup("SIGKILL");
      }, 5000);
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      resolve({ run: { code, stdout, stderr, timedOut }, outputLastMessagePath });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function attemptAnalyze(
  prompt: string,
  codexBin: string,
  timeoutMs: number,
  codexHome: string | undefined,
  schemaPath: string
): Promise<{ ok: boolean; text: string; reason?: string }> {
  const { run, outputLastMessagePath } = await runCodexOnce(
    prompt,
    codexBin,
    timeoutMs,
    codexHome,
    schemaPath
  );
  try {
    if (run.timedOut) {
      return { ok: false, text: "", reason: "timeout" };
    }
    if (run.code !== 0) {
      return { ok: false, text: "", reason: `exit_code_${run.code}` };
    }
    let text = "";
    try {
      text = readFileSync(outputLastMessagePath, "utf-8").trim();
    } catch {
      text = "";
    }
    if (!text) {
      return { ok: false, text: "", reason: "empty_output" };
    }
    return { ok: true, text };
  } finally {
    try {
      rmSync(dirname(outputLastMessagePath), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

export class CodexProvider implements AIProvider {
  name = "codex";
  private codexBin: string;
  private timeoutMs: number;
  private codexHome: string | undefined;

  constructor(opts: CodexProviderOptions = {}) {
    this.codexBin = opts.codexBin ?? process.env.CODEX_BIN ?? "codex";
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.codexHome = opts.codexHome;
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeOutput> {
    const start = Date.now();
    const schemaPath = input.schemaPath ?? SCHEMA_PATH;
    let result = await attemptAnalyze(
      input.prompt,
      this.codexBin,
      this.timeoutMs,
      this.codexHome,
      schemaPath
    );
    if (!result.ok) {
      // one retry on non-zero exit / empty output / timeout
      result = await attemptAnalyze(
        input.prompt,
        this.codexBin,
        this.timeoutMs,
        this.codexHome,
        schemaPath
      );
    }
    const durationMs = Date.now() - start;

    if (!result.ok) {
      throw new Error(`codex exec failed: ${result.reason ?? "unknown"}`);
    }

    const parsed = parseAnalysis(result.text);
    return {
      ...parsed,
      rawOutput: result.text,
      durationMs,
    };
  }

  async healthcheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.codexBin, ["--version"], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  }
}
