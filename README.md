# Cold Call Analyzer

An AI sales coach that reviews every cold call overnight. Each weekday at 3am it pulls the previous day's recorded calls, transcribes them, has Claude break down what happened and what the rep should have said instead, and writes one Notion page per call.

## Why I built it

Our dialer records every call but transcribes only a small fraction of them, and it has no API for transcripts. That made it impossible to answer basic questions like "which objections come up most?" or "which rebuttals actually work?" I wanted every call analyzed the same way, in a form we could sort, filter and count.

## What it produces

For every call, a Notion page with:

- **The play-by-play:** each phase of the call with timestamps, the turning point, and how the opener landed.
- **Every objection:** what the prospect said word for word, what the rep said back, the tactics used, whether it worked, and a better response.
- **A coaching review:** a 1 to 10 score, what went right, what went wrong, and the single change that would have helped most. Every point is backed by a verbatim quote and a timestamp, so it can be checked against the recording in seconds.
- **Account history:** whether the rep used what earlier calls with the same company had already uncovered, and which objections that company keeps raising.

The fields you would want to count (objection type, tactic, outcome, mistake) are fixed categories rather than free text, so "my three most expensive habits" is a simple group-by in Notion. The categories came from clustering the objections in the first batch of real calls.

## How it works

```
Cron (Mon-Fri 3am PT)
  -> Apollo API: calls with recordings from the last 4 days
  -> AssemblyAI: stereo transcription (rep and prospect on separate channels)
  -> Attribution: work out which channel is the rep (2-of-3 vote)
  -> Claude pass 1: structured extraction (objections, talk track, call arc)
  -> Claude pass 2: coaching review (score, mistakes, scripted fixes)
  -> Notion: one page per call
  -> D1 ledger: records each step so nothing is redone
```

## Engineering decisions

- **Who is the rep?** Recordings are stereo, but the channel order isn't stable. The rep was sometimes on the second channel. Three independent signals vote (the rep's name in the opener, talk share, and who speaks first), and 2 of 3 must agree. A validation script scores this against the dialer's own speaker labels: **20 of 20 correct**.
- **Two model passes, not one.** Putting the review into the main schema made the structured-output grammar too large for the API. Splitting it worked out better anyway. The review sees the first pass's findings and the transcript, so the two never disagree, and the cheap extraction pass stays at low effort.
- **No made-up quotes.** A checker re-matches every stored quote against its transcript: **all but one of several hundred quotes were verbatim**. The one miss joined two of the rep's own lines; nothing was invented.
- **Self-healing schedule.** Cloudflare cron has no delivery guarantee, so each run re-sweeps 4 days. A missed night repairs itself, and Friday's calls are picked up Monday.
- **Cheap re-runs.** The ledger stores transcript IDs, so a retry costs nothing. A re-run went from 270s to 16s. `/reanalyze` re-applies new prompts to old calls without transcribing again.
- **Failure isolation.** If the review pass fails, the page is still written with the first pass, and the review is picked up on the next sweep.

## Cost

Roughly $15 a month at low volume: AssemblyAI under $1, Claude under $10, plus the $5 Cloudflare Workers plan.

## Stack

TypeScript, Cloudflare Workers (cron + D1), AssemblyAI, Anthropic Claude API (structured outputs), Apollo API, Notion API.

## Layout

```
src/
  index.ts       routes (/, /status, /run, /reanalyze) and the cron entry point
  run.ts         the pipeline: discover -> transcribe -> attribute -> analyze -> write
  apollo.ts      Apollo client
  assemblyai.ts  transcription
  attribute.ts   the 2-of-3 rep/prospect vote
  analyze.ts     both Claude passes and their schemas
  reanalyze.ts   re-runs current prompts over calls already in the ledger
  notion.ts      page writes with chunking
  db.ts          D1 ledger
scripts/
  validate-attribution.ts   scores rep detection against ground truth
  verify-review-quotes.mjs  checks every stored quote against its transcript
```

## Running it

Copy `.dev.vars.example` to `.dev.vars` and fill in the keys, then `npm install`, `npm run db:init:remote` and `npm run deploy`. In production, secrets are set with `npx wrangler secret put <NAME>` and never committed.

---

Built at Alleviate Health. Company names, people, IDs and URLs in this public copy are placeholders.
