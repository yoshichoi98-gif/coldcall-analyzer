// One-off (2026-11-10): transcript-only backfill into the "Cold Call Analysis" Notion database.
//
// Yoshi removed the disposition + minimum-duration filters and wanted the prior 30 days of calls
// in Notion as identifiers + transcript, WITHOUT the Claude analysis. Same eligibility as the
// nightly run (has a recording, both channels speak); no model calls, so the only spend is
// AssemblyAI.
//
//   node scripts/backfill-transcripts.ts --since 2026-10-11 --until 2026-11-06 --progress <file> [--dry-run]
//
// --until must stop short of the nightly run's lookback window, or the cron would find the
// same calls already in the ledger as `transcript_only` and never give them a full analysis.
//
// Skips any call already in the ledger, except rows parked as `too_short` without a transcript
// (the old 10-second rule), which are eligible now. Results go to a local JSONL progress file
// as each call finishes (so a rerun never double-writes a page) and to the D1 ledger in
// batches with state `transcript_only` — a state the nightly run and /reanalyze never select.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fetchTargetCalls, apolloCallUrl, type TargetCall } from "../src/apollo.ts";
import { submit, waitForCompletion, channelsOf, renderDialogue } from "../src/assemblyai.ts";
import { attribute } from "../src/attribute.ts";
import { createTranscriptPage } from "../src/notion.ts";
import { csv } from "../src/env.ts";

// ---- args ---------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SINCE = arg("since");
const UNTIL = arg("until");
const PROGRESS = arg("progress");
const DRY_RUN = argv.includes("--dry-run");
const CONCURRENCY = Number(arg("concurrency") ?? 8);
if (!SINCE || !UNTIL || !PROGRESS) {
  throw new Error("usage: --since YYYY-MM-DD --until YYYY-MM-DD --progress <file> [--dry-run]");
}

// ---- env: secrets from .dev.vars, vars from wrangler.jsonc (no second copy to drift) ---------
const devVars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const wvar = (k: string) => wrangler.match(new RegExp(`"${k}":\\s*"([^"]*)"`))?.[1] ?? "";

const env = {
  ...devVars,
  NOTION_CALLS_DATABASE_ID: wvar("NOTION_CALLS_DATABASE_ID"),
  REP_NAME_HINTS: wvar("REP_NAME_HINTS"),
  VOCABULARY_BOOST: wvar("VOCABULARY_BOOST"),
} as any;
for (const k of ["APOLLO_SALES_API_KEY", "ASSEMBLYAI_API_KEY", "NOTION_TOKEN", "NOTION_CALLS_DATABASE_ID"]) {
  if (!env[k]) throw new Error(`${k} missing`);
}
const VOCAB = csv(env.VOCABULARY_BOOST);
const HINTS = csv(env.REP_NAME_HINTS);

// ---- D1 via wrangler ----------------------------------------------------------------------
function d1(sql: string): any[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "coldcall-analyzer", "--remote", "--json", "--command", sql],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

const q = (v: unknown) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

interface Result {
  call: TargetCall;
  state: "transcript_only" | "too_short";
  transcriptId: string;
  repChannel?: string;
  repConfidence?: string;
  notionPageId?: string;
  lastError?: string;
}

function upsertSql(r: Result, now: string): string {
  const c = r.call;
  return `INSERT INTO calls (apollo_call_id, disposition, duration_seconds, started_at, contact_name,
      account_name, account_id, account_name_key, email_domain, conversation_id, state,
      transcript_id, rep_channel, rep_confidence, notion_page_id, last_error, first_seen_at, updated_at)
    VALUES (${[
      c.id, c.disposition, c.duration ?? 0, c.start_time, c.contactName, c.accountName, c.accountId,
      c.accountNameKey, c.emailDomain, c.conversation_id, r.state, r.transcriptId, r.repChannel,
      r.repConfidence, r.notionPageId, r.lastError, now, now,
    ].map(q).join(", ")})
    ON CONFLICT(apollo_call_id) DO UPDATE SET
      state = excluded.state, disposition = excluded.disposition,
      transcript_id = excluded.transcript_id, rep_channel = excluded.rep_channel,
      rep_confidence = excluded.rep_confidence, notion_page_id = excluded.notion_page_id,
      last_error = excluded.last_error, updated_at = excluded.updated_at`;
}

let pendingSql: string[] = [];
function flushLedger(force = false) {
  if (pendingSql.length === 0 || (!force && pendingSql.length < 15)) return;
  const batch = pendingSql;
  pendingSql = [];
  d1(batch.join(";\n"));
  console.log(`[ledger] wrote ${batch.length} rows`);
}

// Notion allows ~3 req/s per integration: serialize page writes through one chain.
let notionChain: Promise<unknown> = Promise.resolve();
function viaNotion<T>(fn: () => Promise<T>): Promise<T> {
  const p = notionChain.then(fn);
  notionChain = p.catch(() => {});
  return p;
}

// ---- main ---------------------------------------------------------------------------------
const ledger = d1("SELECT apollo_call_id, state, transcript_id FROM calls");
const skip = new Set(
  ledger.filter((r) => !(r.state === "too_short" && !r.transcript_id)).map((r) => r.apollo_call_id),
);
const done = new Set<string>();
if (existsSync(PROGRESS)) {
  for (const line of readFileSync(PROGRESS, "utf8").split("\n").filter(Boolean)) {
    done.add(JSON.parse(line).call.id);
  }
}

const calls = await fetchTargetCalls(env, SINCE, UNTIL);
const todo = calls.filter((c) => !skip.has(c.id) && !done.has(c.id));

const byDisp: Record<string, number> = {};
for (const c of todo) byDisp[c.disposition] = (byDisp[c.disposition] ?? 0) + 1;
console.log(
  `[plan] window ${SINCE}..${UNTIL}: ${calls.length} recorded calls, ${calls.length - todo.length} already ` +
    `in ledger/progress, ${todo.length} to transcribe`,
);
console.log(`[plan] by disposition: ${JSON.stringify(byDisp)}`);
if (DRY_RUN) process.exit(0);

let written = 0, oneSided = 0, failed = 0, finished = 0;
const failures: string[] = [];

async function processOne(c: TargetCall): Promise<void> {
  const transcriptId = await submit(env.ASSEMBLYAI_API_KEY, c.recording_url!, VOCAB);
  const t = await waitForCompletion(env.ASSEMBLYAI_API_KEY, transcriptId);
  const utterances = t.utterances ?? [];
  const channels = channelsOf(utterances);
  let r: Result;

  if (channels.length < 2) {
    r = { call: c, state: "too_short", transcriptId, lastError: `only ${channels.length} channel(s) with speech` };
    oneSided++;
  } else {
    const a = attribute(utterances, HINTS);
    const dialogue = renderDialogue(utterances, a.repChannel);
    const notionPageId = await viaNotion(() =>
      createTranscriptPage(env, {
        apolloCallId: c.id,
        apolloCallUrl: apolloCallUrl(c.id),
        contactName: c.contactName,
        accountName: c.accountName,
        disposition: c.disposition,
        startedAt: c.start_time,
        durationSeconds: c.duration ?? 0,
        dialogue,
      }),
    );
    r = { call: c, state: "transcript_only", transcriptId, repChannel: a.repChannel, repConfidence: a.confidence, notionPageId };
    written++;
  }

  appendFileSync(PROGRESS, JSON.stringify(r) + "\n");
  pendingSql.push(upsertSql(r, new Date().toISOString()));
  flushLedger();
}

const queue = [...todo];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        await processOne(c);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${c.id}: ${msg.slice(0, 200)}`);
        console.error(`[call ${c.id}] ${msg.slice(0, 300)}`);
      }
      finished++;
      if (finished % 10 === 0) {
        console.log(`[progress] ${finished}/${todo.length} — pages ${written}, one-sided ${oneSided}, failed ${failed}`);
      }
    }
  }),
);

flushLedger(true);
console.log(`[done] ${todo.length} calls: ${written} pages written, ${oneSided} one-sided (skipped), ${failed} failed`);
if (failures.length) console.log(`[failures]\n${failures.join("\n")}`);
