// Re-analysis sweep: re-run the current analysis prompt over calls already in the ledger.
//
// The nightly pipeline only ever looks forward, which means every prompt or schema change
// leaves the back catalogue frozen at whatever the analysis looked like the night it ran. This
// pass closes that gap without re-doing the expensive half of the pipeline: AssemblyAI keeps
// finished transcripts indefinitely and the ledger stores the transcript id and the rep channel,
// so the dialogue is re-rendered from the stored transcript. Apollo is never touched — its
// recording URLs are pre-signed and long dead by now — and nothing is transcribed twice.
//
// Selection is by ABSENCE OF A FIELD in the stored insights, not by a version column: a row
// stops matching the moment its new analysis is saved, so the route is safe to fire repeatedly
// until it reports nothing left. Oldest first, because a re-analyzed call becomes prior-call
// context for the next one at the same account.

import { csv, type Env } from "./env.ts";
import { apolloCallUrl } from "./apollo.ts";
import {
  callsMissingInsightField,
  countMissingInsightField,
  priorCallsForAccount,
  recordError,
  saveInsights,
  setNotionPageId,
  type CallRow,
} from "./db.ts";
import { get as getTranscript, renderDialogue, type Utterance } from "./assemblyai.ts";
import { attribute } from "./attribute.ts";
import { analyzeCall, reviewCall, withReview, type Insights } from "./analyze.ts";
import { archivePage, createCallPage } from "./notion.ts";

/**
 * Field the current schema produces and older stored analyses do not. Bump this to the name of
 * the newest field whenever the schema grows and the back catalogue should be brought forward.
 */
export const SCHEMA_MARKER = "call_review";

/** Calls per invocation. Each one is a full Opus pass, so keep batches small enough to watch. */
const DEFAULT_BATCH = 8;

export interface ReanalyzeReport {
  marker: string;
  /** Rows still carrying pre-change analysis when this batch started. */
  outstanding: number;
  attempted: number;
  reanalyzed: number;
  failed: number;
  errors: string[];
}

export async function reanalyzeBatch(env: Env, limit = DEFAULT_BATCH): Promise<ReanalyzeReport> {
  const outstanding = await countMissingInsightField(env.DB, SCHEMA_MARKER);
  const rows = await callsMissingInsightField(env.DB, SCHEMA_MARKER, Math.max(1, Math.min(limit, 20)));
  const report: ReanalyzeReport = {
    marker: SCHEMA_MARKER,
    outstanding,
    attempted: 0,
    reanalyzed: 0,
    failed: 0,
    errors: [],
  };

  for (const row of rows) {
    report.attempted++;
    try {
      await reanalyzeCall(env, row);
      report.reanalyzed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordError(env.DB, row.apollo_call_id, `reanalyze: ${msg}`);
      report.failed++;
      report.errors.push(`${row.apollo_call_id}: ${msg.slice(0, 200)}`);
      console.error(`[reanalyze ${row.apollo_call_id}] ${msg}`);
    }
  }

  console.log(`[reanalyze] ${JSON.stringify({ ...report, errors: report.errors.length })}`);
  return report;
}

/** Rep's share of speech time, for the stored channel rather than the one attribution picks. */
function talkSharePct(utterances: Utterance[], repChannel: string): number {
  let rep = 0;
  let total = 0;
  for (const u of utterances) {
    const d = Math.max(0, u.end - u.start);
    total += d;
    if (u.channel === repChannel) rep += d;
  }
  return total > 0 ? Math.round((rep / total) * 100) : 0;
}

async function reanalyzeCall(env: Env, row: CallRow): Promise<void> {
  const callId = row.apollo_call_id;
  if (!row.transcript_id) throw new Error("no transcript_id on a written row");

  const transcript = await getTranscript(env.ASSEMBLYAI_API_KEY, row.transcript_id);
  if (transcript.status !== "completed") {
    throw new Error(`stored transcript is ${transcript.status}`);
  }
  const utterances = transcript.utterances ?? [];
  if (utterances.length === 0) throw new Error("stored transcript has no utterances");

  // Prefer the channel the original run recorded — it was validated 20/20 against Apollo's own
  // speaker timelines. Re-attribute only when the ledger somehow has no channel stored.
  const repChannel = row.rep_channel ?? attribute(utterances, csv(env.REP_NAME_HINTS)).repChannel;
  const dialogue = renderDialogue(utterances, repChannel);

  const prior = await priorCallsForAccount(
    env.DB,
    {
      accountId: row.account_id,
      accountNameKey: row.account_name_key,
      emailDomain: row.email_domain,
    },
    row.started_at,
    callId,
  );

  const talkShare = talkSharePct(utterances, repChannel);

  const base = await analyzeCall(env, {
    dialogue,
    disposition: row.disposition ?? "",
    durationSeconds: row.duration_seconds ?? 0,
    contactName: row.contact_name ?? "",
    accountName: row.account_name ?? "",
    repTalkSharePct: talkShare,
    priorCalls: prior.map((p) => ({
      startedAt: p.started_at,
      contactName: p.contact_name,
      disposition: p.disposition,
      insights: safeParse(p.insights_json),
    })),
  });

  const insights = withReview(
    base,
    await reviewCall(env, {
      dialogue,
      disposition: row.disposition ?? "",
      durationSeconds: row.duration_seconds ?? 0,
      contactName: row.contact_name ?? "",
      accountName: row.account_name ?? "",
      repTalkSharePct: talkShare,
      insights: base,
    }),
  );

  // Persist before touching Notion, exactly as the forward pipeline does: if the write fails,
  // the analysis is already banked and the row simply stops matching the sweep.
  await saveInsights(env.DB, callId, JSON.stringify(insights));

  const pageId = await createCallPage(env, {
    apolloCallId: callId,
    apolloCallUrl: apolloCallUrl(callId),
    contactName: row.contact_name ?? "",
    accountName: row.account_name ?? "",
    disposition: row.disposition ?? "",
    startedAt: row.started_at,
    durationSeconds: row.duration_seconds ?? 0,
    repTalkSharePct: talkShare,
    attributionConfidence: row.rep_confidence ?? "unknown",
    insights,
    dialogue,
  });

  // New page first, then bin the old one — a failure here costs a duplicate, not a missing page.
  if (row.notion_page_id) {
    await archivePage(env, row.notion_page_id);
  }
  await setNotionPageId(env.DB, callId, pageId);
  console.log(`[reanalyze ${callId}] score=${insights.call_score} page=${pageId}`);
}

function safeParse(json: string | null): Insights | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Insights;
  } catch {
    return null;
  }
}
