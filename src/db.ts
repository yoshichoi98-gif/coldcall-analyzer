// D1 ledger. One row per Apollo call; `state` is the pipeline position.
//
// Everything here is idempotent on apollo_call_id, because the nightly run deliberately
// re-sweeps a multi-day window: Cloudflare publishes no execution SLA for cron, so a missed
// run has to self-heal on the next one rather than silently drop a day.

export type CallState =
  | "pending"
  | "no_audio"
  | "too_short"
  | "transcribed"
  | "analyzed"
  | "written"
  | "failed"
  /** Notion page holds identifiers + transcript only (2026-11-10 backfill). Never re-selected. */
  | "transcript_only";

export interface CallRow {
  apollo_call_id: string;
  disposition: string | null;
  duration_seconds: number | null;
  started_at: string | null;
  contact_name: string | null;
  account_name: string | null;
  account_id: string | null;
  account_name_key: string | null;
  email_domain: string | null;
  conversation_id: string | null;
  insights_json: string | null;
  state: CallState;
  attempts: number;
  last_error: string | null;
  transcript_id: string | null;
  rep_channel: string | null;
  rep_confidence: string | null;
  notion_page_id: string | null;
  first_seen_at: string | null;
  updated_at: string | null;
}

/**
 * Insert calls we haven't seen, and backfill identity columns on ones we have.
 *
 * Pipeline state is never touched — a call that already reached `written` must not be knocked
 * back to `pending` by a later sweep. But a plain DO NOTHING is wrong too: it means any column
 * added later can never be populated on existing rows, so a new field stays null forever and
 * whatever depends on it silently does nothing. That is exactly how `account_key` shipped
 * broken. Backfill only where the stored value is null, via COALESCE.
 */
export async function upsertNewCalls(
  db: D1Database,
  calls: Array<{
    id: string;
    disposition: string;
    duration: number | null;
    startedAt: string | null;
    contactName: string;
    accountName: string;
    accountId: string | null;
    accountNameKey: string | null;
    emailDomain: string | null;
    conversationId: string | null;
  }>,
  now: string,
): Promise<number> {
  if (calls.length === 0) return 0;

  // D1 is single-threaded — batch rather than awaiting one statement per iteration.
  const stmt = db.prepare(
    `INSERT INTO calls
       (apollo_call_id, disposition, duration_seconds, started_at, contact_name,
        account_name, account_id, account_name_key, email_domain, conversation_id,
        state, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(apollo_call_id) DO UPDATE SET
       account_id       = COALESCE(calls.account_id, excluded.account_id),
       account_name_key = COALESCE(calls.account_name_key, excluded.account_name_key),
       email_domain     = COALESCE(calls.email_domain, excluded.email_domain),
       account_name     = COALESCE(calls.account_name, excluded.account_name),
       contact_name     = COALESCE(calls.contact_name, excluded.contact_name),
       conversation_id  = COALESCE(calls.conversation_id, excluded.conversation_id)`,
  );

  // meta.changes can't be used to count new rows any more: DO UPDATE marks every conflicting
  // row as changed, so it would report every call in the window as "new" on every run. Diff the
  // table size instead.
  const before = await countRows(db);

  await db.batch(
    calls.map((c) =>
      stmt.bind(
        c.id,
        c.disposition,
        c.duration,
        c.startedAt,
        c.contactName,
        c.accountName,
        c.accountId,
        c.accountNameKey,
        c.emailDomain,
        c.conversationId,
        now,
        now,
      ),
    ),
  );

  return (await countRows(db)) - before;
}

async function countRows(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM calls").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Calls still needing work, oldest first. `no_audio` is retried — audio can upload late. */
export async function claimWork(db: D1Database, limit: number): Promise<CallRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM calls
        WHERE state IN ('pending', 'no_audio', 'transcribed', 'analyzed')
        ORDER BY started_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<CallRow>();
  return results ?? [];
}

export async function setState(
  db: D1Database,
  callId: string,
  state: CallState,
  patch: Partial<
    Pick<CallRow, "transcript_id" | "rep_channel" | "rep_confidence" | "notion_page_id" | "last_error">
  > = {},
  now = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE calls SET
         state = ?,
         transcript_id  = COALESCE(?, transcript_id),
         rep_channel    = COALESCE(?, rep_channel),
         rep_confidence = COALESCE(?, rep_confidence),
         notion_page_id = COALESCE(?, notion_page_id),
         last_error     = ?,
         updated_at     = ?
       WHERE apollo_call_id = ?`,
    )
    .bind(
      state,
      patch.transcript_id ?? null,
      patch.rep_channel ?? null,
      patch.rep_confidence ?? null,
      patch.notion_page_id ?? null,
      patch.last_error ?? null,
      now,
      callId,
    )
    .run();
}

/**
 * Record a failure WITHOUT touching `state`.
 *
 * The obvious version of this — passing the row's state back to setState — silently rewinds
 * progress, because the caller is holding the state as it was when the row was claimed. A call
 * that got as far as `transcribed` before the analysis step failed would be written back to
 * `pending`, so the ledger reports work it has actually already done as not started.
 */
export async function recordError(
  db: D1Database,
  callId: string,
  message: string,
  now = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare("UPDATE calls SET last_error = ?, updated_at = ? WHERE apollo_call_id = ?")
    .bind(message.slice(0, 500), now, callId)
    .run();
}

export async function bumpAttempts(db: D1Database, callId: string): Promise<void> {
  await db
    .prepare("UPDATE calls SET attempts = attempts + 1 WHERE apollo_call_id = ?")
    .bind(callId)
    .run();
}

/** One earlier call at the same account, compacted for use as analysis context. */
export interface PriorCall {
  apollo_call_id: string;
  started_at: string | null;
  contact_name: string | null;
  disposition: string | null;
  duration_seconds: number | null;
  insights_json: string | null;
}

/**
 * Earlier analyzed calls to the SAME account, oldest first.
 *
 * A call is a fragment of an account relationship. Analyzing one in isolation repeats — at the
 * account level — the same mistake as scoring an objection against only its adjacent turn: what
 * the site already told us on a previous call is invisible, so the analysis cannot see that the
 * rep re-pitched from scratch or ignored intel already in hand.
 *
 * Matched on ANY of three signals — Apollo account id, normalized company name, or the
 * contact's email domain. None of them is populated on every call (roughly 52% / 81% / 81%),
 * so collapsing them into one key always splits somebody: Bright Path Clinical Studies resolved to
 * an id for one contact and a name for another and never grouped. OR-matching means a call
 * groups as long as it shares *something* with a prior one.
 *
 * Free-mail domains are already excluded upstream, so two strangers with personal addresses
 * cannot be merged into one "account".
 *
 * Only `written` rows are returned — a row mid-pipeline has no insights yet.
 */
export async function priorCallsForAccount(
  db: D1Database,
  match: { accountId: string | null; accountNameKey: string | null; emailDomain: string | null },
  beforeStartedAt: string | null,
  excludeCallId: string,
  limit = 5,
): Promise<PriorCall[]> {
  const { accountId, accountNameKey, emailDomain } = match;
  if (!accountId && !accountNameKey && !emailDomain) return [];

  // Positional placeholders only. Mixing ?N with bare ? is legal SQLite but the anonymous ones
  // then continue from the highest numbered index, which silently misbinds — so each value is
  // repeated explicitly instead.
  const { results } = await db
    .prepare(
      `SELECT apollo_call_id, started_at, contact_name, disposition, duration_seconds, insights_json
         FROM calls
        WHERE apollo_call_id != ?
          AND state = 'written'
          AND insights_json IS NOT NULL
          AND (? IS NULL OR started_at < ?)
          AND (
                (? IS NOT NULL AND account_id       = ?)
             OR (? IS NOT NULL AND account_name_key = ?)
             OR (? IS NOT NULL AND email_domain     = ?)
          )
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .bind(
      excludeCallId,
      beforeStartedAt,
      beforeStartedAt,
      accountId,
      accountId,
      accountNameKey,
      accountNameKey,
      emailDomain,
      emailDomain,
      limit,
    )
    .all<PriorCall>();
  return (results ?? []).reverse(); // oldest first, so the prompt reads chronologically
}

export async function saveInsights(
  db: D1Database,
  callId: string,
  insightsJson: string,
): Promise<void> {
  await db
    .prepare("UPDATE calls SET insights_json = ? WHERE apollo_call_id = ?")
    .bind(insightsJson, callId)
    .run();
}

/** State histogram — what the manual-run route and logs report. */
export async function stateCounts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("SELECT state, COUNT(*) AS n FROM calls GROUP BY state")
    .all<{ state: string; n: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.state, r.n]));
}

/**
 * Calls whose stored analysis predates a schema addition, oldest first.
 *
 * `marker` is a field name the current schema produces and older analyses do not (e.g.
 * "call_review"). Selecting on the absence of the marker rather than on a version column keeps
 * the sweep resumable and idempotent: a re-analyzed row stops matching the moment its new
 * insights are saved, so the same request can be fired repeatedly until it returns nothing.
 */
export async function callsMissingInsightField(
  db: D1Database,
  marker: string,
  limit: number,
): Promise<CallRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM calls
        WHERE state = 'written'
          AND transcript_id IS NOT NULL
          AND (insights_json IS NULL OR insights_json NOT LIKE ?)
        ORDER BY started_at ASC
        LIMIT ?`,
    )
    .bind(`%"${marker}"%`, limit)
    .all<CallRow>();
  return results ?? [];
}

/** How many rows the re-analysis sweep still has left, for progress reporting. */
export async function countMissingInsightField(db: D1Database, marker: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM calls
        WHERE state = 'written'
          AND transcript_id IS NOT NULL
          AND (insights_json IS NULL OR insights_json NOT LIKE ?)`,
    )
    .bind(`%"${marker}"%`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Point a row at a different Notion page.
 *
 * Deliberately not setState: that COALESCEs notion_page_id, which is right for the forward
 * pipeline (never clobber a real page id with a null) and wrong here, where the whole point is
 * to replace a page id that is already set.
 */
export async function setNotionPageId(
  db: D1Database,
  callId: string,
  pageId: string,
  now = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare("UPDATE calls SET notion_page_id = ?, updated_at = ? WHERE apollo_call_id = ?")
    .bind(pageId, now, callId)
    .run();
}
