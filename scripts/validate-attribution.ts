// Stage-3 validation gate: score rep/prospect channel attribution against ground truth.
//
// Ground truth comes free from Apollo. For the subset of calls Apollo promoted to a
// "Conversation", it exposes `timelines.participant_timelines` — per-speaker talk segments with
// millisecond timestamps AND the speaker's real identity (name + account). It gives us no
// transcript text, but it tells us exactly WHEN the rep was talking.
//
// So: transcribe with AssemblyAI, then for each channel measure how much of its speech overlaps
// the Alleviate-Health participant's segments. Highest overlap is, by construction, the rep's
// channel. Compare that to what attribute() guessed with no access to any of it.
//
// Run:  node scripts/validate-attribution.ts [maxCalls]
//
// Costs a few cents of AssemblyAI credit. Read-only against Apollo.

import { readFileSync } from "node:fs";
import { attribute } from "../src/attribute.ts";
import { submit, waitForCompletion, type Utterance } from "../src/assemblyai.ts";

// ---- config -----------------------------------------------------------------

const MAX_CALLS = Number(process.argv[2] ?? 20);
const CONCURRENCY = 4;
const REP_HINTS = ["alleviate", "yoshi"];
const INTERNAL_ACCOUNT = "Alleviate Health";

// ---- secrets ----------------------------------------------------------------

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
) as Record<string, string>;

const APOLLO = env.APOLLO_SALES_API_KEY;
const AAI = env.ASSEMBLYAI_API_KEY;
if (!APOLLO || !AAI) throw new Error("missing APOLLO_SALES_API_KEY or ASSEMBLYAI_API_KEY in .dev.vars");

// ---- apollo -----------------------------------------------------------------

async function apollo<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.apollo.io/api/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-api-key": APOLLO },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`apollo ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

interface Segment { start_time: number; end_time: number }
interface ParticipantTimeline {
  name?: string;
  account_name?: string;
  timeline_segments?: Segment[];
}

/** The Alleviate-side participant's talk segments — our ground truth for "rep is speaking". */
async function repSegments(conversationId: string): Promise<Segment[] | null> {
  const raw = await apollo<any>(`/conversations/${conversationId}`);
  const conv = raw.conversation ?? raw;
  const timelines: ParticipantTimeline[] = conv?.timelines?.participant_timelines ?? [];
  const rep = timelines.find((t) => t.account_name === INTERNAL_ACCOUNT);
  const segs = rep?.timeline_segments ?? [];
  return segs.length ? segs : null;
}

/** Total ms of [a] that falls inside any interval of [b]. */
function overlapMs(a: Array<{ start: number; end: number }>, b: Segment[]): number {
  let total = 0;
  for (const x of a) {
    for (const y of b) {
      const lo = Math.max(x.start, y.start_time);
      const hi = Math.min(x.end, y.end_time);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

// ---- main -------------------------------------------------------------------

interface Row {
  callId: string;
  duration: number;
  disposition: string;
  truth: string;
  predicted: string;
  correct: boolean;
  confidence: string;
  signals: Record<string, string | null>;
  repTalkSharePct: number;
}

async function evaluate(call: any, dispositions: Map<string, string>): Promise<Row | null> {
  const truthSegs = await repSegments(call.conversation_id);
  if (!truthSegs) return null;

  const transcriptId = await submit(AAI, call.recording_url);
  const t = await waitForCompletion(AAI, transcriptId, { intervalMs: 2500, timeoutMs: 240_000 });
  const utterances: Utterance[] = t.utterances ?? [];
  const channels = [...new Set(utterances.map((u) => u.channel))];
  if (channels.length < 2) return null;

  // Ground truth: channel whose speech best lines up with the rep's Apollo timeline.
  let truth = channels[0];
  let best = -1;
  for (const ch of channels) {
    const ov = overlapMs(
      utterances.filter((u) => u.channel === ch).map((u) => ({ start: u.start, end: u.end })),
      truthSegs,
    );
    if (ov > best) { best = ov; truth = ch; }
  }

  const got = attribute(utterances, REP_HINTS);
  return {
    callId: call.id,
    duration: call.duration ?? 0,
    disposition: dispositions.get(call.phone_call_outcome_id ?? "") ?? "?",
    truth,
    predicted: got.repChannel,
    correct: got.repChannel === truth,
    confidence: got.confidence,
    signals: got.signals,
    repTalkSharePct: got.repTalkSharePct,
  };
}

async function main() {
  const facetRes = await apollo<any>("/phone_calls/search", { per_page: 1, page: 1 });
  const dispositions = new Map<string, string>(
    (facetRes.faceting?.phone_call_stats_facets ?? []).map((f: any) => [f.value, f.display_name]),
  );

  const candidates: any[] = [];
  for (let page = 1; page <= 12 && candidates.length < MAX_CALLS; page++) {
    const data = await apollo<any>("/phone_calls/search", { per_page: 100, page });
    const batch = data.phone_calls ?? [];
    for (const c of batch) {
      if (c.conversation_id && c.recording_url) candidates.push(c);
      if (candidates.length >= MAX_CALLS) break;
    }
    if (batch.length < 100) break;
  }

  console.log(`evaluating ${candidates.length} connected calls (ground truth from Apollo timelines)\n`);

  const rows: Row[] = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const slice = candidates.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(slice.map((c) => evaluate(c, dispositions)));
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) {
        rows.push(s.value);
        const r = s.value;
        console.log(
          `  ${r.correct ? "OK  " : "MISS"} ${String(r.duration).padStart(4)}s ` +
            `${r.disposition.padEnd(16)} truth=ch${r.truth} pred=ch${r.predicted} ` +
            `${r.confidence.padEnd(6)} rep_talk=${r.repTalkSharePct}% ` +
            `signals[first=${r.signals.speaksFirst ?? "-"} intro=${r.signals.introMatch ?? "-"} talk=${r.signals.talkShare ?? "-"}]`,
        );
      } else if (s.status === "rejected") {
        console.log(`  ERR  ${String(s.reason).slice(0, 110)}`);
      }
    }
  }

  if (rows.length === 0) { console.log("\nno evaluable calls"); return; }

  const correct = rows.filter((r) => r.correct).length;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`OVERALL: ${correct}/${rows.length} correct (${Math.round((correct / rows.length) * 100)}%)`);

  console.log("\nby reported confidence:");
  for (const level of ["high", "medium", "low"]) {
    const sub = rows.filter((r) => r.confidence === level);
    if (!sub.length) continue;
    const ok = sub.filter((r) => r.correct).length;
    console.log(`  ${level.padEnd(7)} ${ok}/${sub.length} (${Math.round((ok / sub.length) * 100)}%)`);
  }

  console.log("\nper-signal accuracy (when the signal voted at all):");
  for (const key of ["speaksFirst", "introMatch", "talkShare"] as const) {
    const voted = rows.filter((r) => r.signals[key] !== null);
    if (!voted.length) { console.log(`  ${key.padEnd(12)} never voted`); continue; }
    const ok = voted.filter((r) => r.signals[key] === r.truth).length;
    console.log(
      `  ${key.padEnd(12)} ${ok}/${voted.length} (${Math.round((ok / voted.length) * 100)}%)` +
        `  [abstained on ${rows.length - voted.length}]`,
    );
  }

  const misses = rows.filter((r) => !r.correct);
  if (misses.length) {
    console.log(`\n${misses.length} MISSES — inspect these:`);
    for (const m of misses) {
      console.log(`  ${m.callId}  ${m.duration}s  ${m.disposition}  conf=${m.confidence}  rep_talk=${m.repTalkSharePct}%`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
