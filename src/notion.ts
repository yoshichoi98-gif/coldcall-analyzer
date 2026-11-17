// Notion REST client — plain fetch, no SDK.
//
// Two limits here are easy to hit and produce confusing 400s rather than obvious ones:
//   - 2000 characters per rich_text element. A 3-minute transcript blows past this, so the
//     transcript is chunked into multiple paragraph blocks (see `paragraphs`).
//   - 100 block children per request. Long transcripts are appended in follow-up calls.
//
// Rate limit is ~3 requests/second per integration. Writes are therefore SEQUENTIAL —
// deliberately not Promise.all — with a retry on 429.

import type { Env } from "./env.ts";
import type { Insights } from "./analyze.ts";

const BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const MAX_RICH_TEXT = 1900; // under Notion's 2000 with headroom for escaping
const MAX_CHILDREN_PER_REQUEST = 90; // under Notion's 100

async function notion<T>(
  env: Env,
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
  attempt = 0,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
    await new Promise((r) => setTimeout(r, Math.max(1000, retryAfter * 1000)));
    return notion<T>(env, path, method, body, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`notion ${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** Split arbitrary text into paragraph blocks that respect the per-element character cap. */
function paragraphs(text: string): unknown[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > 0) {
    if (remaining.length <= MAX_RICH_TEXT) {
      chunks.push(remaining);
      break;
    }
    // Prefer breaking on a newline so transcript turns stay intact.
    const window = remaining.slice(0, MAX_RICH_TEXT);
    const breakAt = window.lastIndexOf("\n") > 0 ? window.lastIndexOf("\n") : MAX_RICH_TEXT;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks.map((c) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: c } }] },
  }));
}

/** Notion rejects duplicate multi_select options in one write. */
function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function heading(text: string): unknown {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

/** One bullet, optionally bold — used for the lead line of each review finding. */
function bullet(text: string, opts: { bold?: boolean } = {}): unknown {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [
        {
          type: "text",
          text: { content: text.slice(0, MAX_RICH_TEXT) },
          annotations: { bold: !!opts.bold },
        },
      ],
    },
  };
}

/** mm:ss, so a finding can be found in the Apollo recording without doing arithmetic. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function bullets(items: string[]): unknown[] {
  return items.slice(0, 100).map((i) => ({
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [{ type: "text", text: { content: i.slice(0, MAX_RICH_TEXT) } }],
    },
  }));
}

export interface CallPageInput {
  apolloCallId: string;
  /** Permalink to this call in the Apollo web app. */
  apolloCallUrl: string;
  contactName: string;
  accountName: string;
  disposition: string;
  startedAt: string | null;
  durationSeconds: number;
  repTalkSharePct: number;
  attributionConfidence: string;
  insights: Insights;
  dialogue: string;
}

/**
 * Create one Notion page for a call. Returns the new page id.
 * Property names must match the database schema documented in the README.
 */
export async function createCallPage(env: Env, input: CallPageInput): Promise<string> {
  const title =
    [input.contactName || "Unknown", input.accountName].filter(Boolean).join(" — ") +
    (input.startedAt ? ` (${input.startedAt.slice(0, 10)})` : "");

  const review = input.insights.call_review;

  const body: unknown[] = [
    heading("Outcome"),
    ...paragraphs(input.insights.outcome_summary),
  ];

  // The review goes directly under the outcome, above the play-by-play. It is the part that
  // changes the next dial, so it should not be below a transcript-length scroll.
  if (typeof input.insights.call_score === "number") {
    body.push(
      ...paragraphs(
        `Score: ${input.insights.call_score}/10` +
          (review?.biggest_lever ? `\nBiggest lever: ${review.biggest_lever}` : ""),
      ),
    );
  }

  if (review?.what_went_right?.length) {
    body.push(heading("What went right"));
    for (const r of review.what_went_right) {
      body.push(bullet(`${clock(r.at_seconds)} · ${r.category} — ${r.what_you_did}`, { bold: true }));
      body.push(bullet(`   "${r.quote}"`));
      body.push(bullet(`   Why it worked: ${r.why_it_worked}`));
    }
  }

  if (review?.what_went_wrong?.length) {
    body.push(heading("What went wrong"));
    for (const w of review.what_went_wrong) {
      body.push(
        bullet(
          `${clock(w.at_seconds)} · [${w.severity.toUpperCase()}] ${w.category} — ${w.what_happened}`,
          { bold: true },
        ),
      );
      body.push(bullet(`   "${w.quote}"`));
      body.push(bullet(`   Cost: ${w.why_it_cost_you}`));
    }
  }

  if (review?.how_to_improve?.length) {
    body.push(heading("How to improve"));
    for (const h of review.how_to_improve) {
      body.push(bullet(`[${h.priority}] ${h.category}`, { bold: true }));
      if (h.instead_of) body.push(bullet(`   Instead of: "${h.instead_of}"`));
      body.push(bullet(`   Say this: "${h.say_this_instead}"`));
      body.push(bullet(`   Why: ${h.why_this_works}`));
    }
  }

  if (input.insights.call_arc?.length) {
    body.push(heading("How the call went"));
    body.push(
      ...bullets(
        input.insights.call_arc.map(
          (p) => `${String(Math.round(p.start_seconds)).padStart(3)}s — ${p.phase}: ${p.what_happened}`,
        ),
      ),
    );
  }
  if (input.insights.turning_point) {
    body.push(heading("Turning point"), ...paragraphs(input.insights.turning_point));
  }

  if (input.insights.objections.length) {
    body.push(heading("Objections"));
    for (const o of input.insights.objections) {
      body.push(
        ...bullets([
          `${o.handled ? "[HANDLED]" : "[NOT handled]"} ${o.category} — ${o.response_tactics.join(" → ")} — ended: ${o.outcome}`,
          `   THEM: "${o.objection_verbatim}"`,
          `   YOU:  "${o.rep_response_verbatim}"`,
          ...(o.better_response ? [`   BETTER: ${o.better_response}`] : []),
        ]),
      );
    }
  }

  const tt = input.insights.rep_talk_track;
  if (tt) {
    body.push(heading("What you said"));
    body.push(
      ...bullets([
        `Opener: "${tt.opener_verbatim}"`,
        `Asked permission for time: ${tt.asked_permission_for_time ? "yes" : "no"}`,
        `Qualified their role before pitching: ${tt.qualified_role_before_pitching ? "yes" : "NO"}`,
        `Longest unbroken monologue: ${Math.round(tt.longest_uninterrupted_rep_turn_seconds)}s`,
        `Proof points cited: ${tt.proof_points_cited.length ? tt.proof_points_cited.join(", ") : "none"}`,
      ]),
    );
    if (tt.discovery_questions_asked.length) {
      body.push(heading("Questions you asked"), ...bullets(tt.discovery_questions_asked));
    }
  }

  const ac = input.insights.account_continuity;
  if (ac && (ac.missed_context?.length || ac.new_intel?.length || ac.repeated_objections?.length)) {
    body.push(heading("Account history"));
    body.push(
      ...bullets([
        `Used what we already knew about this account: ${ac.prior_context_used ? "yes" : "NO"}`,
        ...(ac.repeated_objections?.length
          ? [`Objections this account has raised before: ${ac.repeated_objections.join(", ")}`]
          : []),
        ...(ac.missed_context ?? []).map((m) => `MISSED: ${m}`),
        ...(ac.new_intel ?? []).map((n) => `NEW: ${n}`),
      ]),
    );
  }

  if (input.insights.prospect_questions.length) {
    body.push(
      heading("Questions they asked (buying signals)"),
      ...bullets(input.insights.prospect_questions),
    );
  }
  if (input.insights.pain_points.length) {
    body.push(heading("Pain points"), ...bullets(input.insights.pain_points));
  }
  if (input.insights.next_steps.length) {
    body.push(
      heading("Next steps"),
      ...bullets(input.insights.next_steps.map((s) => `(${s.owner}) ${s.step}`)),
    );
  }
  if (input.insights.coaching_notes.length) {
    body.push(heading("Coaching"), ...bullets(input.insights.coaching_notes));
  }

  body.push(heading("Transcript"), ...paragraphs(input.dialogue));

  const page = await notion<{ id: string }>(env, "/pages", "POST", {
    parent: { database_id: env.NOTION_CALLS_DATABASE_ID },
    properties: {
      Name: { title: [{ type: "text", text: { content: title.slice(0, 1900) } }] },
      "Apollo Call ID": {
        rich_text: [{ type: "text", text: { content: input.apolloCallId } }],
      },
      // The Apollo app permalink, not `recording_url` — that field is a pre-signed S3 link that
      // expires six hours after it's issued, so a stored copy is dead by morning. This one is
      // just the call id in a UI route and never goes stale; Apollo's player is behind it.
      "Apollo Call": { url: input.apolloCallUrl },
      Disposition: { select: { name: input.disposition } },
      Sentiment: { select: { name: input.insights.prospect_sentiment } },
      "Call Date": input.startedAt ? { date: { start: input.startedAt } } : { date: null },
      "Duration (s)": { number: input.durationSeconds },
      "Rep Talk Share (%)": { number: input.repTalkSharePct },
      "Attribution Confidence": { select: { name: input.attributionConfidence } },

      // Aggregation fields. These exist as PROPERTIES rather than body text specifically so
      // "which objections come up most, and which responses actually work" is a group-by in
      // Notion rather than a re-read of every page.
      "Objection Categories": {
        multi_select: uniq(input.insights.objections.map((o) => o.category)).map((name) => ({ name })),
      },
      "Response Tactics": {
        multi_select: uniq(input.insights.objections.flatMap((o) => o.response_tactics)).map((name) => ({ name })),
      },
      "Objection Outcomes": {
        multi_select: uniq(input.insights.objections.map((o) => o.outcome)).map((name) => ({ name })),
      },
      "Objections Raised": { number: input.insights.objections.length },
      "Objections Handled": { number: input.insights.objections.filter((o) => o.handled).length },
      "Proof Points Cited": {
        multi_select: uniq(input.insights.rep_talk_track?.proof_points_cited ?? []).map((name) => ({ name })),
      },
      "Qualified Role First": {
        checkbox: !!input.insights.rep_talk_track?.qualified_role_before_pitching,
      },
      "Used Account History": {
        checkbox: !!input.insights.account_continuity?.prior_context_used,
      },
      "Repeat Account Objections": {
        multi_select: uniq(input.insights.account_continuity?.repeated_objections ?? []).map(
          (name) => ({ name }),
        ),
      },
      // The coaching read, surfaced as columns so the table itself answers "which calls were
      // worst and why" — score sorts, the two category lists group, the lever reads at a glance.
      "Call Score": { number: typeof input.insights.call_score === "number" ? input.insights.call_score : null },
      Mistakes: {
        multi_select: uniq((input.insights.call_review?.what_went_wrong ?? []).map((w) => w.category)).map(
          (name) => ({ name }),
        ),
      },
      Strengths: {
        multi_select: uniq((input.insights.call_review?.what_went_right ?? []).map((r) => r.category)).map(
          (name) => ({ name }),
        ),
      },
      "Critical Mistakes": {
        number: (input.insights.call_review?.what_went_wrong ?? []).filter((w) => w.severity === "critical")
          .length,
      },
      "Biggest Lever": {
        rich_text: [
          { type: "text", text: { content: (input.insights.call_review?.biggest_lever ?? "").slice(0, MAX_RICH_TEXT) } },
        ],
      },

      "Longest Monologue (s)": {
        number: Math.round(input.insights.rep_talk_track?.longest_uninterrupted_rep_turn_seconds ?? 0),
      },
      Prospect: { rich_text: [{ type: "text", text: { content: input.contactName || "" } }] },
      Account: { rich_text: [{ type: "text", text: { content: input.accountName || "" } }] },
    },
    // Notion caps children per request; send the first slice with the page.
    children: body.slice(0, MAX_CHILDREN_PER_REQUEST),
  });

  // Append any overflow blocks, sequentially, respecting the same cap.
  for (let i = MAX_CHILDREN_PER_REQUEST; i < body.length; i += MAX_CHILDREN_PER_REQUEST) {
    await notion(env, `/blocks/${page.id}/children`, "PATCH", {
      children: body.slice(i, i + MAX_CHILDREN_PER_REQUEST),
    });
  }

  return page.id;
}

export interface TranscriptPageInput {
  apolloCallId: string;
  apolloCallUrl: string;
  contactName: string;
  accountName: string;
  disposition: string;
  startedAt: string | null;
  durationSeconds: number;
  dialogue: string;
}

/**
 * Identifiers + transcript only — no analysis, no review, analysis columns left blank.
 *
 * Built for the 2026-11-10 transcript backfill (scripts/backfill-transcripts.ts): Yoshi wanted
 * the prior 30 days of calls in the database so they're readable, without paying for scoring.
 * Ledger state for these rows is `transcript_only`, which neither the nightly run nor
 * /reanalyze selects.
 */
export async function createTranscriptPage(env: Env, input: TranscriptPageInput): Promise<string> {
  const title =
    [input.contactName || "Unknown", input.accountName].filter(Boolean).join(" — ") +
    (input.startedAt ? ` (${input.startedAt.slice(0, 10)})` : "");

  const body = [heading("Transcript"), ...paragraphs(input.dialogue)];

  const page = await notion<{ id: string }>(env, "/pages", "POST", {
    parent: { database_id: env.NOTION_CALLS_DATABASE_ID },
    properties: {
      Name: { title: [{ type: "text", text: { content: title.slice(0, 1900) } }] },
      "Apollo Call ID": { rich_text: [{ type: "text", text: { content: input.apolloCallId } }] },
      "Apollo Call": { url: input.apolloCallUrl },
      Disposition: { select: { name: input.disposition } },
      "Call Date": input.startedAt ? { date: { start: input.startedAt } } : { date: null },
      "Duration (s)": { number: input.durationSeconds },
      Prospect: { rich_text: [{ type: "text", text: { content: input.contactName || "" } }] },
      Account: { rich_text: [{ type: "text", text: { content: input.accountName || "" } }] },
    },
    children: body.slice(0, MAX_CHILDREN_PER_REQUEST),
  });

  for (let i = MAX_CHILDREN_PER_REQUEST; i < body.length; i += MAX_CHILDREN_PER_REQUEST) {
    await notion(env, `/blocks/${page.id}/children`, "PATCH", {
      children: body.slice(i, i + MAX_CHILDREN_PER_REQUEST),
    });
  }

  return page.id;
}

/**
 * Send a page to the Notion trash.
 *
 * The re-analysis pass REPLACES a page rather than editing it in place. Editing would mean
 * archiving every existing child block one request at a time — a call page runs 40-100 blocks,
 * so re-reviewing the back catalogue would be ~3,000 sequential requests against a 3/sec
 * integration limit. Create-then-archive is two requests. Order matters: the replacement is
 * created first, so a failure here leaves a duplicate (fixable) rather than no page at all.
 */
export async function archivePage(env: Env, pageId: string): Promise<void> {
  await notion(env, `/pages/${pageId}`, "PATCH", { archived: true });
}
