// The nightly pipeline. One pass = discover -> transcribe -> attribute -> analyze -> write.
//
// Everything runs inside a single cron invocation. No webhooks, no queues, no Durable Objects:
// polling AssemblyAI spends wall clock and subrequests, both of which a paid Worker has in
// abundance (15 min CPU on a >=1hr cron, 10k subrequests), and it avoids standing up a second
// public route that would need its own authentication.
//
// The run is resumable by construction. Every call's position lives in D1, and the discovery
// step re-sweeps a multi-day window, so a missed or half-finished run is repaired by the next
// one rather than silently dropping calls.

import { csv, num, type Env } from "./env.ts";
import { fetchTargetCalls, fetchFreshRecordingUrl, lookbackDate, apolloCallUrl } from "./apollo.ts";
import {
  upsertNewCalls,
  claimWork,
  setState,
  bumpAttempts,
  recordError,
  stateCounts,
  priorCallsForAccount,
  saveInsights,
  type CallRow,
} from "./db.ts";
import type { Insights } from "./analyze.ts";
import { submit, waitForCompletion, renderDialogue, channelsOf } from "./assemblyai.ts";
import { attribute } from "./attribute.ts";
import { analyzeCall, reviewCall, withReview } from "./analyze.ts";
import { createCallPage } from "./notion.ts";

/** Give up on a call after this many failed passes so one bad row can't block every run. */
const MAX_ATTEMPTS = 4;

/** Ceiling on calls processed per run. Normal volume is far below this; it is a runaway backstop. */
const MAX_PER_RUN = 40;

export interface RunReport {
  discovered: number;
  processed: number;
  written: number;
  skipped: number;
  failed: number;
  states: Record<string, number>;
  errors: string[];
}

/**
 * @param limit  Cap on calls processed this pass. Defaults to MAX_PER_RUN. Pass a small number
 *               to sanity-check output before committing a batch, or to drip-feed a big catch-up
 *               sweep across several runs.
 */
export async function runOnce(env: Env, limit = MAX_PER_RUN): Promise<RunReport> {
  const now = new Date();
  const report: RunReport = {
    discovered: 0,
    processed: 0,
    written: 0,
    skipped: 0,
    failed: 0,
    states: {},
    errors: [],
  };

  // ---- 1. discover -----------------------------------------------------------
  const since = lookbackDate(num(env.LOOKBACK_DAYS, 4), now);
  const until = lookbackDate(0, now);

  const calls = await fetchTargetCalls(env, since, until);
  report.discovered = await upsertNewCalls(
    env.DB,
    calls.map((c) => ({
      id: c.id,
      disposition: c.disposition,
      duration: c.duration,
      startedAt: c.start_time,
      contactName: c.contactName,
      accountName: c.accountName,
      accountId: c.accountId,
      accountNameKey: c.accountNameKey,
      emailDomain: c.emailDomain,
      conversationId: c.conversation_id,
    })),
    now.toISOString(),
  );
  console.log(`[discover] window ${since}..${until}: ${calls.length} target calls, ${report.discovered} new`);

  // ---- 2. process ------------------------------------------------------------
  const work = await claimWork(env.DB, Math.max(1, Math.min(limit, MAX_PER_RUN)));

  for (const row of work) {
    if (row.attempts >= MAX_ATTEMPTS) {
      await setState(env.DB, row.apollo_call_id, "failed", {
        last_error: `gave up after ${row.attempts} attempts`,
      });
      report.failed++;
      continue;
    }

    try {
      const outcome = await processCall(env, row);
      report.processed++;
      if (outcome === "written") report.written++;
      if (outcome === "skipped") report.skipped++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await bumpAttempts(env.DB, row.apollo_call_id);
      // Record the error but leave `state` where processCall left it — a call that reached
      // `transcribed` must not be rewound to `pending`, or the ledger under-reports real work
      // and every retry looks like a fresh start.
      await recordError(env.DB, row.apollo_call_id, msg);
      report.failed++;
      report.errors.push(`${row.apollo_call_id}: ${msg.slice(0, 200)}`);
      console.error(`[call ${row.apollo_call_id}] ${msg}`);
    }
  }

  report.states = await stateCounts(env.DB);
  console.log(`[run] ${JSON.stringify({ ...report, errors: report.errors.length })}`);
  return report;
}

type Outcome = "written" | "skipped";

/**
 * Run the review pass, but never let it sink the call.
 *
 * The review is additive — a page with the analysis and no review is worth far more than no page
 * at all, and losing one costs nothing permanent: `/reanalyze` selects on the ABSENCE of
 * `call_review` in a `written` row, so a call that skips the review here is picked up by the next
 * sweep. Without this the second pass is a new single point of failure in front of the Notion
 * write, which is the one step that was already proven.
 */
async function reviewOrSkip(
  env: Env,
  callId: string,
  input: Parameters<typeof reviewCall>[1],
): Promise<Insights> {
  try {
    return withReview(input.insights, await reviewCall(env, input));
  } catch (err) {
    console.error(
      `[call ${callId}] review pass failed, writing without it: ` +
        `${err instanceof Error ? err.message : err}`,
    );
    return input.insights;
  }
}

async function processCall(env: Env, row: CallRow): Promise<Outcome> {
  const callId = row.apollo_call_id;

  // No minimum-duration gate (removed 2026-11-10). A call with no two-way speech is still
  // skipped below, after transcription, when one channel comes back silent.

  // Re-fetch the recording URL: Apollo re-signs it on every response, so a stored one is
  // already stale. A null here means the audio never uploaded — leave the row retryable,
  // since it may still appear while the call is inside the lookback window.
  const recordingUrl = await fetchFreshRecordingUrl(env, callId);
  if (!recordingUrl) {
    await bumpAttempts(env.DB, callId);
    await setState(env.DB, callId, "no_audio", { last_error: "no recording_url yet" });
    return "skipped";
  }

  // ---- transcribe ------------------------------------------------------------
  const transcriptId =
    row.transcript_id ?? (await submit(env.ASSEMBLYAI_API_KEY, recordingUrl, csv(env.VOCABULARY_BOOST)));
  const transcript = await waitForCompletion(env.ASSEMBLYAI_API_KEY, transcriptId);
  const utterances = transcript.utterances ?? [];

  const channels = channelsOf(utterances);
  if (channels.length < 2) {
    // One leg silent — a voicemail or an unanswered dial that still logged a disposition.
    await setState(env.DB, callId, "too_short", {
      transcript_id: transcriptId,
      last_error: `only ${channels.length} channel(s) with speech`,
    });
    return "skipped";
  }

  // ---- attribute -------------------------------------------------------------
  const attribution = attribute(utterances, csv(env.REP_NAME_HINTS));
  await setState(env.DB, callId, "transcribed", {
    transcript_id: transcriptId,
    rep_channel: attribution.repChannel,
    rep_confidence: attribution.confidence,
  });

  const dialogue = renderDialogue(utterances, attribution.repChannel);

  // ---- analyze ---------------------------------------------------------------
  // Already analyzed and only the Notion write failed? Reuse the stored insights instead of
  // paying for the model again. This is the whole reason insights_json is persisted BEFORE the
  // page is created — without this branch, a Notion outage silently re-bills every queued call
  // on the next run.
  let stored = row.state === "analyzed" ? safeParse(row.insights_json) : null;
  if (stored) {
    console.log(`[call ${callId}] reusing stored analysis, retrying Notion write only`);
    // A row that was analyzed before the review pass existed would otherwise be written out
    // permanently missing it — the Notion retry is its last visit through the pipeline.
    if (!stored.call_review) {
      stored = await reviewOrSkip(env, callId, {
        dialogue,
        disposition: row.disposition ?? "",
        durationSeconds: row.duration_seconds ?? 0,
        contactName: row.contact_name ?? "",
        accountName: row.account_name ?? "",
        repTalkSharePct: attribution.repTalkSharePct,
        insights: stored,
      });
      if (stored.call_review) await saveInsights(env.DB, callId, JSON.stringify(stored));
    }
    const pageId = await createCallPage(env, {
      apolloCallId: callId,
      apolloCallUrl: apolloCallUrl(callId),
      contactName: row.contact_name ?? "",
      accountName: row.account_name ?? "",
      disposition: row.disposition ?? "",
      startedAt: row.started_at,
      durationSeconds: row.duration_seconds ?? 0,
      repTalkSharePct: attribution.repTalkSharePct,
      attributionConfidence: attribution.confidence,
      insights: stored,
      dialogue,
    });
    await setState(env.DB, callId, "written", { notion_page_id: pageId });
    return "written";
  }

  // Pull earlier calls at the same account first. A call is a fragment of an account
  // relationship — analyzing it blind repeats, one level up, the mistake of scoring an
  // objection against only the turn next to it.
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
  if (prior.length) {
    console.log(`[call ${callId}] ${prior.length} prior call(s) at ${row.account_name}`);
  }

  const base = await analyzeCall(env, {
    dialogue,
    disposition: row.disposition ?? "",
    durationSeconds: row.duration_seconds ?? 0,
    contactName: row.contact_name ?? "",
    accountName: row.account_name ?? "",
    repTalkSharePct: attribution.repTalkSharePct,
    priorCalls: prior.map((p) => ({
      startedAt: p.started_at,
      contactName: p.contact_name,
      disposition: p.disposition,
      insights: safeParse(p.insights_json),
    })),
  });

  // Second pass — the coaching review, written against the first pass's findings plus the
  // transcript. Separate call because one combined schema exceeds the structured-output
  // grammar limit, and because judgement wants more effort than extraction does.
  const insights = await reviewOrSkip(env, callId, {
    dialogue,
    disposition: row.disposition ?? "",
    durationSeconds: row.duration_seconds ?? 0,
    contactName: row.contact_name ?? "",
    accountName: row.account_name ?? "",
    repTalkSharePct: attribution.repTalkSharePct,
    insights: base,
  });
  await setState(env.DB, callId, "analyzed", { transcript_id: transcriptId });
  // Persist before the Notion write, so a failure there doesn't lose the analysis — and so the
  // next call at this account can use it even if this one never finished.
  await saveInsights(env.DB, callId, JSON.stringify(insights));

  // ---- write -----------------------------------------------------------------
  const pageId = await createCallPage(env, {
    apolloCallId: callId,
    apolloCallUrl: apolloCallUrl(callId),
    contactName: row.contact_name ?? "",
    accountName: row.account_name ?? "",
    disposition: row.disposition ?? "",
    startedAt: row.started_at,
    durationSeconds: row.duration_seconds ?? 0,
    repTalkSharePct: attribution.repTalkSharePct,
    attributionConfidence: attribution.confidence,
    insights,
    dialogue,
  });

  await setState(env.DB, callId, "written", { notion_page_id: pageId });
  return "written";
}

/** A malformed stored blob must not sink the current call — prior context is a bonus, not a dependency. */
function safeParse(json: string | null): Insights | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Insights;
  } catch {
    return null;
  }
}
