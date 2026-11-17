/** Bindings, vars, and secrets available to the Worker. Mirrors wrangler.jsonc. */
export interface Env {
  // bindings
  DB: D1Database;

  // vars (wrangler.jsonc -> "vars")
  LOOKBACK_DAYS: string;
  REP_NAME_HINTS: string;
  /** Domain proper nouns fed to AssemblyAI so it stops spelling them phonetically. */
  VOCABULARY_BOOST: string;
  ANTHROPIC_MODEL: string;
  NOTION_CALLS_DATABASE_ID: string;

  // secrets (wrangler secret put — see .dev.vars.example)
  APOLLO_SALES_API_KEY: string;
  ASSEMBLYAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  NOTION_TOKEN: string;
  MANUAL_RUN_TOKEN: string;
}

/** Comma-separated var -> trimmed, non-empty list. */
export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
