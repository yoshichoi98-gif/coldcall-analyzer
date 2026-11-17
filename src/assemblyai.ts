// AssemblyAI transcription.
//
// We pass a remote `audio_url` rather than uploading bytes, so the Worker never handles audio.
// Apollo's recording URLs need no auth, which is what makes that possible.
//
// `multichannel: true` — NOT `speaker_labels`. Apollo recordings are stereo 8kHz WAV with the
// two call legs on separate physical channels, so channel separation is deterministic. Acoustic
// diarization would be a model guess (~70-80% on short telephony audio) where this is exact.
// The two options are mutually exclusive; sending both is a config error.
//
// Response shape confirmed against a live Apollo call:
//   { status, audio_duration, text, utterances: [{ start, end, text, channel, speaker, words }] }
//
// GOTCHA: `channel` is a STRING and 1-INDEXED — "1" and "2", not 0 and 1. Comparing it to a
// number silently never matches.

const BASE = "https://api.assemblyai.com/v2";

export interface Utterance {
  start: number; // ms
  end: number; // ms
  text: string;
  channel: string; // "1" | "2"
  speaker?: string;
}

export interface Transcript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  audio_duration?: number; // seconds
  text?: string;
  utterances?: Utterance[];
  error?: string;
}

async function call<T>(apiKey: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      // Bare key — no "Bearer " prefix. (AssemblyAI tolerates the prefix, but the bare
      // form is what their reference documents.)
      authorization: apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`assemblyai ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/**
 * @param keyTerms Domain vocabulary biasing recognition — competitor names, CTMS vendors,
 *   customers. Without it the model spells unfamiliar proper nouns phonetically (a competitor's
 *   name comes back as a sound-alike), which quietly corrupts competitor tracking,
 *   since a name the transcript gets wrong is a name you cannot group or count on.
 *
 * USE `keyterms_prompt`, NOT `word_boost`. `word_boost` (with `boost_param`) is the legacy
 * Conformer-era parameter: the API still ACCEPTS it and returns 200, then ignores it on the
 * current model. Verified against a real call — word_boost left the misspelling untouched; switching
 * to keyterms_prompt spelled both names correctly. A silently-ignored parameter is the
 * worst kind, so don't "simplify" this back.
 */
export async function submit(
  apiKey: string,
  audioUrl: string,
  keyTerms: string[] = [],
): Promise<string> {
  const job = await call<Transcript>(apiKey, "/transcript", {
    audio_url: audioUrl,
    multichannel: true,
    ...(keyTerms.length ? { keyterms_prompt: keyTerms } : {}),
  });
  return job.id;
}

export async function get(apiKey: string, transcriptId: string): Promise<Transcript> {
  return call<Transcript>(apiKey, `/transcript/${transcriptId}`);
}

/**
 * Poll until the transcript finishes.
 *
 * Called inside the single cron invocation rather than via webhook: polling spends wall clock
 * and subrequests, both of which a paid Worker has in abundance (15 min CPU on a >=1hr cron,
 * 10k subrequests), and it avoids standing up a second public route to authenticate.
 *
 * Real calls of this length complete in seconds; the timeout is a backstop.
 */
export async function waitForCompletion(
  apiKey: string,
  transcriptId: string,
  { intervalMs = 3000, timeoutMs = 300_000 } = {},
): Promise<Transcript> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const t = await get(apiKey, transcriptId);
    if (t.status === "completed") return t;
    if (t.status === "error") throw new Error(`transcription failed: ${t.error ?? "unknown"}`);
    if (Date.now() > deadline) {
      throw new Error(`transcription timed out after ${timeoutMs}ms (status=${t.status})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Distinct channel ids present, sorted. Expect ["1","2"]; anything else means mono audio. */
export function channelsOf(utterances: Utterance[]): string[] {
  return [...new Set(utterances.map((u) => u.channel))].sort();
}

/** Utterances for one channel, chronological. */
export function onChannel(utterances: Utterance[], channel: string): Utterance[] {
  return utterances.filter((u) => u.channel === channel).sort((a, b) => a.start - b.start);
}

/**
 * Render as a labelled transcript for the analysis prompt.
 * Speakers are named REP / PROSPECT so the model never has to infer who is who.
 */
export function renderDialogue(utterances: Utterance[], repChannel: string): string {
  return [...utterances]
    .sort((a, b) => a.start - b.start)
    .map((u) => {
      const who = u.channel === repChannel ? "REP" : "PROSPECT";
      const ts = (u.start / 1000).toFixed(1).padStart(6);
      return `[${ts}s] ${who}: ${u.text}`;
    })
    .join("\n");
}
