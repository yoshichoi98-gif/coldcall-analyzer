// Decide which stereo channel is the rep and which is the prospect.
//
// This is the step that would otherwise silently corrupt every downstream insight. The channel
// order is NOT stable across calls — measured against Apollo's own labelled speaker timelines,
// the rep was on the first channel in only 5 of 7 calls. Hardcoding "channel 1 = rep" would
// attribute the prospect's objections to your own rep on roughly a third of calls.
//
// Three independent signals, each validated on real transcripts:
//
//   1. PROSPECT SPEAKS FIRST (7/7). On an outbound dial the prospect answers "Hello?" before
//      the rep opens. Measured on the earliest utterance in the call.
//   2. REP INTRO WORD MATCH. The rep opens with "this is <name> from Alleviate Health".
//      Matched against REP_NAME_HINTS over each channel's opening utterances.
//   3. REP TALK SHARE (7/7). The rep out-talks the prospect on connected cold calls.
//
// Majority vote. Two of three agreeing is enough; unanimity is reported as high confidence and
// a bare majority as medium. A tie (which needs at least one signal to abstain) falls back to
// talk share and is flagged low, for review rather than silent trust.

import { onChannel, type Utterance } from "./assemblyai.ts";

export type Confidence = "high" | "medium" | "low";

export interface Attribution {
  repChannel: string;
  prospectChannel: string;
  confidence: Confidence;
  /** Per-signal votes, for logging and for the Stage-3 validation run. */
  signals: {
    speaksFirst: string | null; // channel voted rep, or null if it abstained
    introMatch: string | null;
    talkShare: string | null;
  };
  repTalkSharePct: number;
}

/** Signal 1 — whoever speaks SECOND is the rep. */
function voteSpeaksFirst(utterances: Utterance[], channels: string[]): string | null {
  const firstBy = new Map<string, number>();
  for (const ch of channels) {
    const first = onChannel(utterances, ch)[0];
    if (first) firstBy.set(ch, first.start);
  }
  if (firstBy.size < 2) return null;

  const sorted = [...firstBy.entries()].sort((a, b) => a[1] - b[1]);
  // Both legs opening within ~300ms is a simultaneous "hello" — no usable signal.
  if (sorted[1][1] - sorted[0][1] < 300) return null;
  return sorted[1][0]; // second to speak == rep
}

/**
 * Signal 2 — the rep names themselves and the company in their opener.
 * Only the first few utterances per channel are considered: the prospect often repeats the
 * company name later in the call, which would flip the vote if the whole transcript were scanned.
 */
function voteIntroMatch(
  utterances: Utterance[],
  channels: string[],
  hints: string[],
  openingUtterances = 3,
): string | null {
  if (hints.length === 0) return null;

  const scores = new Map<string, number>();
  for (const ch of channels) {
    const opening = onChannel(utterances, ch)
      .slice(0, openingUtterances)
      .map((u) => u.text.toLowerCase())
      .join(" ");
    scores.set(ch, hints.filter((h) => opening.includes(h)).length);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0) return null; // nobody matched
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null; // tie
  return ranked[0][0];
}

/** Signal 3 — the rep talks more. Measured in words, which is robust to silence and crosstalk. */
function voteTalkShare(
  utterances: Utterance[],
  channels: string[],
): { winner: string | null; sharePct: number } {
  const words = new Map<string, number>();
  for (const ch of channels) {
    words.set(
      ch,
      onChannel(utterances, ch).reduce((n, u) => n + u.text.trim().split(/\s+/).filter(Boolean).length, 0),
    );
  }

  const total = [...words.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { winner: null, sharePct: 0 };

  const ranked = [...words.entries()].sort((a, b) => b[1] - a[1]);
  const sharePct = Math.round((ranked[0][1] / total) * 100);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return { winner: null, sharePct };
  return { winner: ranked[0][0], sharePct };
}

export function attribute(utterances: Utterance[], repNameHints: string[]): Attribution {
  const channels = [...new Set(utterances.map((u) => u.channel))].sort();
  if (channels.length < 2) {
    // Mono, or one leg silent (voicemail, no-answer). Nothing to attribute.
    throw new Error(`expected 2 channels, got ${channels.length}: [${channels.join(", ")}]`);
  }

  const speaksFirst = voteSpeaksFirst(utterances, channels);
  const introMatch = voteIntroMatch(utterances, channels, repNameHints);
  const talk = voteTalkShare(utterances, channels);

  const votes = [speaksFirst, introMatch, talk.winner].filter((v): v is string => v !== null);

  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);

  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const tied = ranked.length > 1 && ranked[0][1] === ranked[1][1];

  let repChannel: string;
  let confidence: Confidence;

  if (ranked.length === 0 || tied) {
    // No usable signal, or a genuine split. Fall back to talk share and flag for review.
    repChannel = talk.winner ?? channels[0];
    confidence = "low";
  } else {
    repChannel = ranked[0][0];
    confidence = ranked[0][1] >= 3 ? "high" : ranked[0][1] === 2 ? "medium" : "low";
  }

  const prospectChannel = channels.find((c) => c !== repChannel) ?? channels[0];
  const repWords = onChannel(utterances, repChannel).reduce(
    (n, u) => n + u.text.trim().split(/\s+/).filter(Boolean).length,
    0,
  );
  const allWords = utterances.reduce(
    (n, u) => n + u.text.trim().split(/\s+/).filter(Boolean).length,
    0,
  );

  return {
    repChannel,
    prospectChannel,
    confidence,
    signals: { speaksFirst, introMatch, talkShare: talk.winner },
    repTalkSharePct: allWords ? Math.round((repWords / allWords) * 100) : 0,
  };
}
