// Verify the Notion write path without spending an Anthropic call.
//
// Pulls a real completed transcript from AssemblyAI, runs the real attribution and dialogue
// rendering, then writes a page with a STUBBED insight object. That exercises everything that
// actually breaks in practice — property-name mismatches, the 2000-char rich_text cap, and the
// 100-children-per-request cap — none of which depend on the analysis step.
//
// Run:  node scripts/test-notion-write.ts
// Creates one page in the Cold Call Analysis database. Delete it afterwards.

import { readFileSync } from "node:fs";
import { get, renderDialogue, type Utterance } from "../src/assemblyai.ts";
import { attribute } from "../src/attribute.ts";
import { createCallPage } from "../src/notion.ts";
import type { Env } from "../src/env.ts";

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
) as Record<string, string>;

const DATABASE_ID = "00000000000000000000000000000052";

const env = {
  NOTION_TOKEN: vars.NOTION_TOKEN,
  NOTION_CALLS_DATABASE_ID: DATABASE_ID,
} as Env;

// Use the LONGEST completed transcript we've already paid for — a short one would write a
// single block and prove nothing about the chunking, which is the failure mode worth testing.
const listRes = await fetch("https://api.assemblyai.com/v2/transcript?limit=50", {
  headers: { authorization: vars.ASSEMBLYAI_API_KEY },
});
const list = (await listRes.json()) as { transcripts: Array<{ id: string; status: string }> };
const completed = list.transcripts.filter((t) => t.status === "completed");
if (!completed.length) throw new Error("no completed transcripts to test with");

const fetched = await Promise.all(completed.slice(0, 25).map((t) => get(vars.ASSEMBLYAI_API_KEY, t.id)));
const transcript = fetched.reduce((a, b) => ((b.audio_duration ?? 0) > (a.audio_duration ?? 0) ? b : a));
const done = { id: transcript.id };
const utterances: Utterance[] = transcript.utterances ?? [];
console.log(`transcript ${done.id}: ${utterances.length} utterances, ${transcript.audio_duration}s`);

const att = attribute(utterances, ["alleviate", "yoshi"]);
const dialogue = renderDialogue(utterances, att.repChannel);
console.log(`rep=ch${att.repChannel} (${att.confidence}), talk share ${att.repTalkSharePct}%`);
console.log(`dialogue is ${dialogue.length} chars -> exercises the 2000-char chunking\n`);

const pageId = await createCallPage(env, {
  apolloCallId: "TEST-" + done.id.slice(0, 8),
  contactName: "Notion Write Test",
  accountName: "delete me",
  disposition: "Not Interested",
  startedAt: new Date().toISOString(),
  durationSeconds: Math.round(transcript.audio_duration ?? 0),
  repTalkSharePct: att.repTalkSharePct,
  attributionConfidence: att.confidence,
  insights: {
    outcome_summary:
      "STUB — this page verifies the Notion write path only. The analysis step was not run.",
    prospect_sentiment: "neutral",
    objections: [
      { objection: "stub objection", rep_response: "stub response", handled: true },
    ],
    pain_points: ["stub pain point"],
    next_steps: [{ step: "delete this test page", owner: "rep" }],
    coaching_notes: ["stub coaching note"],
  },
  dialogue,
});

console.log(`created page: https://notion.so/${pageId.replace(/-/g, "")}`);
