// Check every quote in every stored coaching review against the transcript it came from.
//
// The review is only worth reading if the quotes are real — the rep will check one against the
// recording, and a single invented line discredits the rest. This is the cheap standing check:
// it re-fetches each call's AssemblyAI transcript (free, they are kept indefinitely) and asserts
// that each quoted line actually appears in it.
//
// Matching is loose on purpose: case, punctuation, and whitespace are normalized away, and a
// leading "REP:"/"PROSPECT:" label or [12.3s] timestamp is stripped. What it catches is invented
// or paraphrased content, not formatting.
//
//   node scripts/verify-review-quotes.mjs          # every re-analyzed call
//   node scripts/verify-review-quotes.mjs <apollo_call_id>  # one call

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const only = process.argv[2];

const key = fs
  .readFileSync(`${ROOT}.dev.vars`, "utf8")
  .split("\n")
  .find((l) => l.startsWith("ASSEMBLYAI_API_KEY="))
  ?.slice("ASSEMBLYAI_API_KEY=".length)
  .trim();
if (!key) throw new Error("ASSEMBLYAI_API_KEY not found in .dev.vars");

const where = only
  ? `apollo_call_id = '${only.replace(/'/g, "")}'`
  : "insights_json LIKE '%call_review%'";
const raw = execFileSync(
  "npx",
  [
    "wrangler", "d1", "execute", "coldcall-analyzer", "--remote", "--json",
    "--command",
    `SELECT apollo_call_id, contact_name, transcript_id, insights_json FROM calls WHERE ${where} ORDER BY started_at`,
  ],
  { cwd: ROOT, maxBuffer: 1 << 28, encoding: "utf8" },
);
const rows = JSON.parse(raw.slice(raw.indexOf("[")))[0].results ?? [];

const norm = (s) =>
  s
    .replace(/^(REP|PROSPECT)\s*:\s*/i, "")
    .replace(/\[[\d.]+s\]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

let checked = 0;
let missed = 0;

for (const row of rows) {
  const t = await (
    await fetch(`https://api.assemblyai.com/v2/transcript/${row.transcript_id}`, {
      headers: { authorization: key },
    })
  ).json();
  // Three haystacks, because a real quote can fail a naive substring check three ways.
  // Sorted-by-start is the call as it was heard; the two per-channel streams exist because a
  // quote spanning one speaker's consecutive utterances has the other speaker's "yeah" spliced
  // into the middle of the merged stream, which reads as invented when it is not.
  const utterances = [...(t.utterances ?? [])].sort((a, b) => a.start - b.start);
  const haystacks = [
    norm(utterances.map((u) => u.text).join(" ")),
    ...[...new Set(utterances.map((u) => u.channel))].map((ch) =>
      norm(utterances.filter((u) => u.channel === ch).map((u) => u.text).join(" ")),
    ),
  ];
  const somewhere = (frag) => haystacks.some((h) => h.includes(frag));

  // A quote that deliberately shows both sides carries speaker labels; check each side against
  // the transcript separately rather than demanding the labelled string appear verbatim.
  const present = (q) => {
    const fragments = q
      .split(/\s*\/\s*|\b(?:REP|PROSPECT)\s*:\s*/i)
      .map(norm)
      .filter((f) => f.split(" ").length >= 4);
    if (fragments.length === 0) return somewhere(norm(q));
    return fragments.every(somewhere);
  };

  const insights = JSON.parse(row.insights_json ?? "{}");
  const review = insights.call_review;
  if (!review) {
    console.log(`${row.apollo_call_id}  no review stored — skipped`);
    continue;
  }

  const quotes = [
    ...(review.what_went_right ?? []).map((x) => ["right", x.quote]),
    ...(review.what_went_wrong ?? []).map((x) => ["wrong", x.quote]),
    ...(review.how_to_improve ?? []).filter((x) => x.instead_of).map((x) => ["instead_of", x.instead_of]),
  ];

  const bad = quotes.filter(([, q]) => !present(q));
  checked += quotes.length;
  missed += bad.length;

  const label = `${row.apollo_call_id}  ${row.contact_name ?? ""}`.trim();
  console.log(`${bad.length ? "FAIL" : "ok  "} ${label}  ${quotes.length - bad.length}/${quotes.length} verbatim  score=${insights.call_score ?? "?"}`);
  for (const [kind, q] of bad) console.log(`       [${kind}] ${JSON.stringify(q.slice(0, 140))}`);
}

console.log(`\n${checked - missed}/${checked} quotes verbatim across ${rows.length} call(s)`);
process.exit(missed ? 1 : 0);
