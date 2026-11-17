// Claude analysis pass.
//
// Uses the official Anthropic SDK rather than raw fetch. This is the one runtime dependency in
// the project — every other API here (Apollo, AssemblyAI, Notion) is plain fetch, matching the
// zero-dependency convention of the sibling Workers. The SDK earns its place for an unattended
// nightly job: it retries 429s and 5xx with backoff on its own, which is exactly the failure
// mode a 3am cron hits and nobody is awake to notice.
//
// Model notes for claude-opus-5, each of which is a 400 or a silent bug if ignored:
//   - Thinking is ON BY DEFAULT. max_tokens caps thinking + response text TOGETHER, so it needs
//     real headroom or the answer truncates mid-object.
//   - temperature / top_p / top_k / budget_tokens are all REMOVED and return 400. Depth is
//     controlled with output_config.effort instead.
//   - Structured output goes through output_config.format. Assistant-turn prefill (the old way
//     to force JSON) also returns 400 on this model.

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env.ts";

/**
 * Content-analysis schema: what the prospect objected to, what the rep said back, whether it
 * worked, and which talk-track pieces were actually used.
 *
 * The design constraint that matters: **free text cannot be aggregated.** "What are my most
 * common objections and which rebuttals land?" is a GROUP BY, so every field you'd want to
 * count is a fixed enum, with the verbatim quote alongside it for reading. The enums are not
 * invented — they were derived by clustering the objections in the first batch of analyzed calls.
 */

/** Objection taxonomy, derived by clustering early calls. */
const OBJECTION_CATEGORIES = [
  "already_in_house", //  already handled internally or by another tool
  "flat_no_reason", //     "not interested", no reason offered
  "brush_off_defer", //    "send me an email" / "call me back" / "I'm busy"
  "no_decision_authority",// "not the decision maker"
  "trust_privacy", //      "how did you get my number" / "take me off your list"
  "capability_doubt", //   doubts the product can do the job
  "no_perceived_need", //  "we don't need it"
  "wrong_fit", //          needs something adjacent, not this product
  "vendor_fatigue", //     tired of vendor calls
  "timing_budget", //      bad timing / budget owner elsewhere
  "other",
] as const;

/**
 * What the rep DID with the objection. An ARRAY, not one label — a real response is usually a
 * sequence ("acknowledged, then reframed, then probed"), and collapsing that to a single tactic
 * mislabels the most common good move on these calls: soften first, then keep selling.
 *
 * `conceded` is deliberately narrow. It means the rep dropped the thread and never came back to
 * it for the rest of the call. A soft "no problem" followed by continued selling is
 * `acknowledged` + whatever came next — NOT a concession.
 */
const RESPONSE_TACTICS = [
  "no_response", //   said nothing, or the call ended before a reply
  "acknowledged", //  softened/agreed verbally ("totally", "no problem") — neutral on its own
  "conceded", //      dropped the thread entirely and moved to exit; nothing further, all call
  "clarified", //     corrected a factual misunderstanding about the product
  "reframed", //      changed the frame (restated the value in the prospect's terms)
  "probed", //        asked a question back
  "proof_point", //   cited a customer, stat, or case study
  "deferred", //      pushed it to email/callback instead of addressing the substance
  "re_engaged", //    came back to this objection LATER in the call after first moving past it
  "other",
] as const;

/** Where the objection ended up by the time the call finished. */
const OBJECTION_OUTCOMES = [
  "resolved", //          prospect visibly accepted the response and moved on
  "rep_re_engaged", //    rep returned to it later and made a real attempt
  "rep_dropped_it", //    rep never came back to it
  "prospect_dropped_it",//prospect moved on themselves
  "ended_call", //        this objection is where the call ended
] as const;

/** Coarse phases, so the call can be read start to finish rather than as loose fragments. */
const CALL_PHASES = [
  "opening", //            greeting, name, identifying self
  "permission", //         asking for time
  "role_qualification", // checking whether this person owns recruitment
  "pitch", //              value prop delivery
  "discovery", //          questions about their process
  "objection_handling",
  "close", //              asking for the meeting / next step
  "wrap", //               logistics, email confirmation, goodbye
] as const;

/** Reusable proof points, so you can see which ones actually get used and which land. */
const PROOF_POINTS = [
  "customer_count_claim",
  "usage_volume_claim",
  "named_case_study",
  "named_customer_other",
  "compliance",
  "integration",
  "positioning_statement",
  "product_capability",
  "other",
] as const;

/**
 * What the rep did wrong, as a fixed vocabulary. Same reasoning as the objection taxonomy:
 * "my three most expensive habits, ranked by how often they show up" is a GROUP BY, and free
 * text can't be grouped. The verbatim quote and the specific fix ride alongside as text.
 */
const MISTAKE_CATEGORIES = [
  "weak_opener", //               opened without a reason for the call landing in one line
  "no_permission_ask", //         launched in without asking for time
  "pitched_before_qualifying", // pitched someone whose role was never established
  "monologue", //                 long unbroken talk track, no check-in
  "feature_dump", //              listed capabilities instead of naming a problem
  "no_discovery", //              asked nothing about how they actually recruit
  "vague_value_prop", //          value stated so generically it fit any vendor
  "no_proof_point", //            claim made with no customer, number, or case behind it
  "accepted_brush_off", //        took "send me an email" / "not interested" as final
  "deferred_instead_of_answering",// answered a substantive question with "I'll email you"
  "ignored_buying_signal", //     prospect leaned in or asked a real question, rep moved past it
  "talked_over_prospect", //      interrupted or spoke through their reply
  "no_close_attempt", //          never asked for a meeting or a next step
  "no_next_step_set", //          call ended with nothing concrete on either side
  "wrong_person_not_redirected", // reached the wrong person and never asked who owns it
  "low_energy_or_rushed", //      pace/tone undercut the words
  "misread_their_business", //    got their model, size, or role wrong on the call
  "other",
] as const;

/** What the rep did well. Same purpose in reverse — find what to repeat, not just what to fix. */
const STRENGTH_CATEGORIES = [
  "strong_opener",
  "asked_permission",
  "qualified_role_early",
  "concise_pitch",
  "good_discovery_question",
  "relevant_proof_point",
  "reframed_objection",
  "persisted_after_no",
  "tone_and_rapport",
  "handled_objection_well",
  "clear_ask_for_meeting",
  "confirmed_next_step",
  "redirected_to_right_person",
  "other",
] as const;

const INSIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "outcome_summary",
    "prospect_sentiment",
    "objections",
    "call_arc",
    "turning_point",
    "account_continuity",
    "rep_talk_track",
    "prospect_questions",
    "pain_points",
    "next_steps",
    "coaching_notes",
  ],
  properties: {
    outcome_summary: {
      type: "string",
      description: "2-3 sentences: what happened on this call and how it ended.",
    },
    prospect_sentiment: {
      type: "string",
      enum: ["positive", "neutral", "negative", "hostile", "indeterminate"],
    },
    objections: {
      type: "array",
      description:
        "Every objection, push-back, or deflection the prospect raised — in order. An unanswered one still counts.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "category",
          "objection_verbatim",
          "rep_response_verbatim",
          "response_tactics",
          "outcome",
          "handled",
          "better_response",
        ],
        properties: {
          category: { type: "string", enum: [...OBJECTION_CATEGORIES] },
          objection_verbatim: {
            type: "string",
            description: "The prospect's own words. Quote, do not paraphrase into sales jargon.",
          },
          rep_response_verbatim: {
            type: "string",
            description:
              "Everything the rep said in response to THIS objection, across the whole call — including anything said later after moving past it. Quote it. If the rep never replied, say so plainly.",
          },
          response_tactics: {
            type: "array",
            description:
              "Every tactic used on this objection, in order. Usually more than one. Only use 'conceded' if the rep dropped it for the rest of the call.",
            items: { type: "string", enum: [...RESPONSE_TACTICS] },
          },
          outcome: { type: "string", enum: [...OBJECTION_OUTCOMES] },
          handled: {
            type: "boolean",
            description:
              "True only if the rep engaged the substance at some point in the call. Accepting the objection and exiting is NOT handled; nor is agreeing to send an email instead of answering.",
          },
          better_response: {
            type: "string",
            description:
              "A specific line the rep could have used instead, in their voice. Empty string if the response was already good.",
          },
        },
      },
    },
    rep_talk_track: {
      type: "object",
      description: "What the rep actually said and did, independent of how the prospect reacted.",
      additionalProperties: false,
      required: [
        "opener_verbatim",
        "asked_permission_for_time",
        "qualified_role_before_pitching",
        "proof_points_cited",
        "discovery_questions_asked",
        "longest_uninterrupted_rep_turn_seconds",
      ],
      properties: {
        opener_verbatim: {
          type: "string",
          description: "The rep's first substantive line, quoted.",
        },
        asked_permission_for_time: {
          type: "boolean",
          description: "Did the rep ask for time up front (e.g. 'do you have 30 seconds')?",
        },
        qualified_role_before_pitching: {
          type: "boolean",
          description:
            "Did the rep confirm this person owns or influences recruitment BEFORE launching the pitch?",
        },
        proof_points_cited: {
          type: "array",
          items: { type: "string", enum: [...PROOF_POINTS] },
        },
        discovery_questions_asked: {
          type: "array",
          items: { type: "string" },
          description: "Questions the REP asked the prospect, quoted. Empty if none.",
        },
        longest_uninterrupted_rep_turn_seconds: {
          type: "number",
          description:
            "Duration of the rep's longest single unbroken turn, from the transcript timestamps. Monologue length.",
        },
      },
    },
    call_arc: {
      type: "array",
      description:
        "The call start to finish, in order — how it opened, how it developed, where it turned, how it ended. One entry per phase that actually occurred; skip phases that never happened (most cold calls never reach role_qualification or close).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "start_seconds", "what_happened"],
        properties: {
          phase: { type: "string", enum: [...CALL_PHASES] },
          start_seconds: {
            type: "number",
            description: "Timestamp this phase began, from the transcript.",
          },
          what_happened: {
            type: "string",
            description: "One or two sentences on what actually occurred in this phase.",
          },
        },
      },
    },
    turning_point: {
      type: "string",
      description:
        "The single moment that set the call's direction — quote it and say why it mattered. Empty string if the call was too short to have one.",
    },
    account_continuity: {
      type: "object",
      description:
        "How this call relates to earlier calls at the SAME account. All fields empty/false when there are no prior calls.",
      additionalProperties: false,
      required: ["prior_context_used", "missed_context", "new_intel", "repeated_objections"],
      properties: {
        prior_context_used: {
          type: "boolean",
          description:
            "Did the rep visibly use anything learned on a previous call at this account (named a colleague, referenced a prior conversation, skipped ground already covered)?",
        },
        missed_context: {
          type: "array",
          items: { type: "string" },
          description:
            "Specific things already known from earlier calls at this account that the rep should have used here and didn't. Empty if none or if this is the first call.",
        },
        new_intel: {
          type: "array",
          items: { type: "string" },
          description:
            "What this call adds to the account picture that earlier calls did not have — org structure, tooling, timing, names.",
        },
        repeated_objections: {
          type: "array",
          items: { type: "string" },
          description:
            "Objection categories this account has now raised on more than one call. These are the account's real blockers, not one person's brush-off.",
        },
      },
    },
    prospect_questions: {
      type: "array",
      items: { type: "string" },
      description:
        "Questions the PROSPECT asked, quoted. These are buying signals — empty on a call that never engaged.",
    },
    pain_points: {
      type: "array",
      items: { type: "string" },
      description: "Problems the prospect described. Empty if none surfaced.",
    },
    next_steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "owner"],
        properties: {
          step: { type: "string" },
          owner: { type: "string", enum: ["rep", "prospect", "unclear"] },
        },
      },
    },
    coaching_notes: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific, actionable observations about the rep's execution. Quote the transcript. Empty if the call was too short to judge.",
    },
  },
} as const;

/**
 * The coaching review — a SECOND model pass, deliberately not folded into INSIGHT_SCHEMA.
 *
 * One schema holding both is what you write first, and the API rejects it outright: "the
 * compiled grammar is too large". Structured output compiles the entire schema into a grammar,
 * and the combined object — five enum vocabularies plus three more arrays of enum-tagged
 * objects — went past that ceiling. Splitting it is also better work: this pass reads the
 * transcript AND the first pass's findings, so the review is written against a call that has
 * already been mapped, and the mostly-extraction first pass keeps its validated `low` effort
 * while the judgement runs at `medium`.
 */
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["call_score", "what_went_right", "what_went_wrong", "how_to_improve", "biggest_lever"],
  properties: {
    call_score: {
      type: "number",
      description:
        "Overall execution score, 1-10, judged on THIS call's ceiling — a 20-second flat 'not interested' can still be a 7 if the rep did everything available to them. 1-3: fumbled the basics or gave up on contact. 4-6: competent, missed obvious openings. 7-8: strong execution, minor gaps. 9-10: near the best this call could have gone. Score the rep's decisions, not the outcome.",
    },
    what_went_right: {
      type: "array",
      description:
        "Concrete moments that worked, most significant first. Empty only if there is genuinely nothing — on a 15-second call, picking up the phone is not an achievement.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "what_you_did", "quote", "why_it_worked", "at_seconds"],
        properties: {
          category: { type: "string", enum: [...STRENGTH_CATEGORIES] },
          what_you_did: { type: "string", description: "One sentence, concrete, in the second person." },
          quote: {
            type: "string",
            description:
              "The exact line from the transcript, copied character for character — no cleanup, no paraphrase, no merging two turns. Include the speaker label if the moment needs both sides.",
          },
          why_it_worked: {
            type: "string",
            description: "What it did to the call. Point at the prospect's next line as evidence where there is one.",
          },
          at_seconds: { type: "number", description: "Timestamp of the quote, from the transcript." },
        },
      },
    },
    what_went_wrong: {
      type: "array",
      description:
        "Concrete mistakes, most costly first. A thing NOT done counts — never asking who owns recruitment is a mistake with no quote of its own, so quote the moment where it should have happened.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "what_happened", "quote", "why_it_cost_you", "severity", "at_seconds"],
        properties: {
          category: { type: "string", enum: [...MISTAKE_CATEGORIES] },
          what_happened: { type: "string", description: "One or two sentences, concrete, in the second person." },
          quote: {
            type: "string",
            description:
              "The exact transcript line where this went wrong, copied character for character. For something the rep failed to do, quote the turn where the opening was and say so.",
          },
          why_it_cost_you: {
            type: "string",
            description: "The mechanism, not a platitude: what this specifically cost on THIS call.",
          },
          severity: {
            type: "string",
            enum: ["minor", "moderate", "critical"],
            description: "critical = plausibly the reason the call ended where it did.",
          },
          at_seconds: { type: "number" },
        },
      },
    },
    how_to_improve: {
      type: "array",
      description:
        "The fixes, highest leverage first. Each one must be sayable out loud on the next dial — a rewritten line, not a principle.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "instead_of", "say_this_instead", "why_this_works", "priority"],
        properties: {
          category: { type: "string", enum: [...MISTAKE_CATEGORIES] },
          instead_of: {
            type: "string",
            description:
              "The rep's actual words being replaced, verbatim. Empty string only when the fix is something that was never said at all.",
          },
          say_this_instead: {
            type: "string",
            description:
              "The replacement line, written out in full and in the rep's own voice — what they would actually say, not a description of what to say. No em-dashes.",
          },
          why_this_works: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    biggest_lever: {
      type: "string",
      description:
        "The single change that would have done the most for THIS call, in one or two sentences. One thing, not a list.",
    },
  },
} as const;

export interface Objection {
  category: string;
  objection_verbatim: string;
  rep_response_verbatim: string;
  response_tactics: string[];
  outcome: string;
  handled: boolean;
  better_response: string;
}

export interface CallPhase {
  phase: string;
  start_seconds: number;
  what_happened: string;
}

export interface RepTalkTrack {
  opener_verbatim: string;
  asked_permission_for_time: boolean;
  qualified_role_before_pitching: boolean;
  proof_points_cited: string[];
  discovery_questions_asked: string[];
  longest_uninterrupted_rep_turn_seconds: number;
}

export interface AccountContinuity {
  prior_context_used: boolean;
  missed_context: string[];
  new_intel: string[];
  repeated_objections: string[];
}

export interface Strength {
  category: string;
  what_you_did: string;
  quote: string;
  why_it_worked: string;
  at_seconds: number;
}

export interface Mistake {
  category: string;
  what_happened: string;
  quote: string;
  why_it_cost_you: string;
  severity: string;
  at_seconds: number;
}

export interface Improvement {
  category: string;
  instead_of: string;
  say_this_instead: string;
  why_this_works: string;
  priority: string;
}

export interface CallReview {
  what_went_right: Strength[];
  what_went_wrong: Mistake[];
  how_to_improve: Improvement[];
  biggest_lever: string;
}

export interface Insights {
  outcome_summary: string;
  prospect_sentiment: string;
  objections: Objection[];
  call_arc: CallPhase[];
  turning_point: string;
  account_continuity: AccountContinuity;
  rep_talk_track: RepTalkTrack;
  prospect_questions: string[];
  pain_points: string[];
  next_steps: Array<{ step: string; owner: string }>;
  coaching_notes: string[];
  /** Filled by the second pass (`reviewCall`). Absent on analyses stored before it existed. */
  call_score?: number;
  call_review?: CallReview;
}

/** Flat return shape of the review pass; the caller folds it into `Insights`. */
export interface Review {
  call_score: number;
  what_went_right: Strength[];
  what_went_wrong: Mistake[];
  how_to_improve: Improvement[];
  biggest_lever: string;
}

const SYSTEM = `You analyze outbound cold calls for Alleviate Health, which sells AI patient recruitment to clinical research sites.

The transcript is speaker-separated and already labelled: REP is the Alleviate salesperson, PROSPECT is the person they called. Trust those labels.

The point of this analysis is the exchange itself: what the prospect pushed back on, what the rep said in return, and whether it worked. Quote both sides verbatim. Paraphrasing an objection into sales jargon destroys the thing being studied.

READ THE ENTIRE CALL BEFORE SCORING ANY OBJECTION. Objections are not resolved in the turn immediately after they are raised. A rep will routinely soften first — "totally", "no problem", "absolutely" — and then keep selling in the same breath or come back to it a minute later. That opening softener is \`acknowledged\`, not \`conceded\`. Judge each objection on everything the rep said about it across the whole call, and set \`outcome\` to record where it actually ended up.

\`conceded\` means one specific thing: the rep dropped that thread and never returned to it for the remainder of the call. If the rep said "no problem" and then reframed, probed, or pitched again — on that objection or as a direct continuation — the tactics are \`acknowledged\` plus whatever followed. Using \`conceded\` for a soft acknowledgement is the single most common way to get this analysis wrong.

\`response_tactics\` is a list because real responses are sequences. Most good responses have two or three entries.

Be strict about \`handled\`. It is true only when the rep engaged the substance at some point in the call. Accepting it politely and exiting is NOT handled, and neither is agreeing to send an email instead of answering. But a delayed, genuine attempt DOES count — that is exactly what reading the full call is for.

Capture every objection, including ones the rep never answered. A flat "I'm not interested" with no reply is one of the most important rows in the dataset.

\`call_arc\` should let someone who never heard the call follow it start to finish: how it opened, how it developed, where it turned, how it ended.

When earlier calls to the same account are provided, treat this call as the next chapter of one relationship, not a standalone event. A site that raised in-house tooling on two separate calls with two different people is telling you something an individual brush-off is not. Judge whether the rep actually used what was already known — a name, a competitor, a timing constraint — or started from zero as if the account had never been touched.

If the call was too short or too garbled to support a field, return an empty array rather than inventing content — an empty objections list is a valid and useful answer.

Coaching notes are for the rep who made the call. Be specific and concrete; skip generic advice that would apply to any call.`;


const REVIEW_SYSTEM = `You review outbound cold calls for Alleviate Health, which sells AI patient recruitment to clinical research sites. You are writing to the rep who made the call, in the second person.

You get the full transcript — REP is the Alleviate salesperson, PROSPECT is the person they called; trust the labels — plus the structured analysis of the same call from an earlier pass. Read the transcript yourself. The earlier pass is a map of the call, not a substitute for it, and where it and the transcript disagree the transcript wins.

Hold this to a higher bar than a summary would need:

EVERY QUOTE MUST BE REAL. Copy the line out of the transcript character for character — same words, same fillers, same false starts. Do not tidy it, do not stitch two turns into one, do not summarize a stretch of talk and put quotation marks around it. If you cannot find a line that supports the point, the point does not go in. A fabricated quote makes the whole review worthless, because the rep will check it against the recording.

Be direct about what went wrong. This is for one person who wants to sell better, not a performance review — no cushioning, no "consider possibly". Name the mistake, quote the moment, and say what it cost on THIS call. A thing the rep never did is still a mistake: quote the turn where the opening was and say what should have gone there.

\`what_went_right\` is not consolation. Only real moments, each tied to a quote. If the call was 20 seconds of "not interested", it is fine to return one entry or none.

\`how_to_improve\` must be sayable out loud on the next dial. Write the actual replacement line in the rep's voice, the words they would say, not a description of the strategy. "Ask about their current process" is useless; "Before I get into it, how are you handling that today?" is the deliverable. Do not use em-dashes in these lines; they do not read as speech.

Score the DECISIONS, not the outcome. A flat no from a well-run call scores higher than a booked meeting the prospect was always going to take. Judge against what was available on this call.`;

export interface PriorCallContext {
  startedAt: string | null;
  contactName: string | null;
  disposition: string | null;
  insights: Insights | null;
}

/**
 * Render earlier calls at this account as prompt context.
 *
 * Compacted deliberately — the full prior transcripts would dwarf the call being analyzed and
 * bury it. What carries forward is what was learned and what blocked: outcome, objections, and
 * intel. The current call's own transcript is always passed in full.
 */
function renderPriorCalls(prior: PriorCallContext[], accountName: string): string[] {
  if (prior.length === 0) return [];

  const lines = [
    `PRIOR CALLS TO THIS ACCOUNT (${accountName || "same account"}) — ${prior.length}, oldest first.`,
    `This is an ongoing account relationship, not a first touch. Judge whether the rep used any of this.`,
    ``,
  ];

  for (const [i, p] of prior.entries()) {
    const when = p.startedAt ? p.startedAt.slice(0, 10) : "unknown date";
    lines.push(`--- prior call ${i + 1}: ${p.contactName || "unknown"} on ${when} (${p.disposition || "?"})`);
    if (p.insights) {
      lines.push(`    outcome: ${p.insights.outcome_summary}`);
      const objs = p.insights.objections ?? [];
      if (objs.length) {
        lines.push(
          `    objections raised: ${objs.map((o) => `${o.category} ("${o.objection_verbatim.slice(0, 90)}")`).join("; ")}`,
        );
      }
      const intel = p.insights.account_continuity?.new_intel ?? [];
      if (intel.length) lines.push(`    intel learned: ${intel.join("; ")}`);
      if (p.insights.pain_points?.length) {
        lines.push(`    pain points: ${p.insights.pain_points.join("; ")}`);
      }
    }
    lines.push("");
  }

  return lines;
}

export async function analyzeCall(
  env: Env,
  input: {
    dialogue: string;
    disposition: string;
    durationSeconds: number;
    contactName: string;
    accountName: string;
    repTalkSharePct: number;
    /** Earlier analyzed calls at this account, oldest first. Empty on a first touch. */
    priorCalls?: PriorCallContext[];
  },
): Promise<Insights> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const userContent = [
    `Call metadata:`,
    `- Prospect: ${input.contactName || "unknown"}${input.accountName ? ` at ${input.accountName}` : ""}`,
    `- Duration: ${input.durationSeconds}s`,
    `- Rep's logged disposition: ${input.disposition}`,
    `- Rep share of speech: ${input.repTalkSharePct}%`,
    ``,
    ...renderPriorCalls(input.priorCalls ?? [], input.accountName),
    `Transcript:`,
    input.dialogue,
  ].join("\n");

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL || "claude-opus-5",
    // Generous: this budget covers thinking AND the response on claude-opus-5.
    max_tokens: 8000,
    system: SYSTEM,
    // `low` is genuinely strong on this model and is the cost lever for what is mostly
    // extraction. The judgement work is in reviewCall below, which runs at `medium`.
    // Do NOT reach for temperature, which is rejected outright.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: INSIGHT_SCHEMA },
    },
    messages: [{ role: "user", content: userContent }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  if (response.stop_reason === "max_tokens") {
    throw new Error("analysis truncated at max_tokens — raise the budget");
  }
  if (response.stop_reason === "refusal") {
    throw new Error("analysis refused by safety classifier");
  }

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text block in analysis response");

  try {
    return JSON.parse(text.text) as Insights;
  } catch {
    // Seen once in an early batch: a bare "Unexpected end of JSON input", which says nothing
    // about what actually came back. Surface the length and the tail so the next occurrence is
    // diagnosable from the log alone. The run's retry usually clears it.
    throw new Error(
      `analysis returned unparseable JSON (stop_reason=${response.stop_reason}, ` +
        `${text.text.length} chars, ends: ${JSON.stringify(text.text.slice(-80))})`,
    );
  }
}

/**
 * Second pass: the coaching review.
 *
 * Runs after `analyzeCall` and receives its output, so the two never disagree about what
 * happened on the call — and so this pass spends its effort on judgement (what was the most
 * expensive moment, what line should have gone there) rather than re-deriving the objections.
 *
 * `medium` effort, not `low`: at `low` this came back hedged and reached for advice that would
 * fit any call, which is the one thing the review must not be.
 */
export async function reviewCall(
  env: Env,
  input: {
    dialogue: string;
    disposition: string;
    durationSeconds: number;
    contactName: string;
    accountName: string;
    repTalkSharePct: number;
    insights: Insights;
  },
): Promise<Review> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const firstPass = {
    outcome_summary: input.insights.outcome_summary,
    prospect_sentiment: input.insights.prospect_sentiment,
    turning_point: input.insights.turning_point,
    call_arc: input.insights.call_arc,
    objections: input.insights.objections,
    rep_talk_track: input.insights.rep_talk_track,
    prospect_questions: input.insights.prospect_questions,
    pain_points: input.insights.pain_points,
    account_continuity: input.insights.account_continuity,
  };

  const userContent = [
    `Call metadata:`,
    `- Prospect: ${input.contactName || "unknown"}${input.accountName ? ` at ${input.accountName}` : ""}`,
    `- Duration: ${input.durationSeconds}s`,
    `- Rep's logged disposition: ${input.disposition}`,
    `- Rep share of speech: ${input.repTalkSharePct}%`,
    ``,
    `Analysis from the first pass (JSON):`,
    JSON.stringify(firstPass, null, 2),
    ``,
    `Transcript:`,
    input.dialogue,
  ].join("\n");

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL || "claude-opus-5",
    // Headroom for thinking plus a review that quotes the transcript in every entry.
    max_tokens: 16000,
    system: REVIEW_SYSTEM,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: REVIEW_SCHEMA },
    },
    messages: [{ role: "user", content: userContent }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  if (response.stop_reason === "max_tokens") {
    throw new Error("review truncated at max_tokens — raise the budget");
  }
  if (response.stop_reason === "refusal") {
    throw new Error("review refused by safety classifier");
  }

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text block in review response");

  try {
    return JSON.parse(text.text) as Review;
  } catch {
    throw new Error(
      `review returned unparseable JSON (stop_reason=${response.stop_reason}, ` +
        `${text.text.length} chars, ends: ${JSON.stringify(text.text.slice(-80))})`,
    );
  }
}

/** Fold a review pass into the insight object that gets stored and rendered. */
export function withReview(insights: Insights, review: Review): Insights {
  return {
    ...insights,
    call_score: review.call_score,
    call_review: {
      what_went_right: review.what_went_right,
      what_went_wrong: review.what_went_wrong,
      how_to_improve: review.how_to_improve,
      biggest_lever: review.biggest_lever,
    },
  };
}
