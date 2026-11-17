// Apollo REST client — the SALES workspace.
//
// Auth is the `x-api-key` header (not Bearer). Base path is /api/v1, not /v1.
//
// Two hard-won facts about recording_url, both verified against the live workspace:
//   1. It is RE-SIGNED on every response (S3 presign, X-Amz-Expires=21600). Never persist it —
//      cache the call id and re-fetch immediately before handing the URL to AssemblyAI.
//   2. It needs NO authentication to download, on either host. That is what lets AssemblyAI
//      fetch the audio itself so this Worker never touches audio bytes.
//
// Recordings land on api.twilio.com first and migrate to Apollo's S3 bucket later, so fresh
// calls are downloadable immediately — a nightly job never waits on an upload.

import type { Env } from "./env.ts";

const BASE = "https://api.apollo.io/api/v1";

/**
 * Permalink to a call in the Apollo web app.
 *
 * Stable — it's just the call id in a UI route, so it never expires. Note this is NOT the same
 * as `recording_url`: that field is a pre-signed S3 link carrying X-Amz-Expires=21600 and is
 * dead six hours after it's issued. The app URL is the durable one, and Apollo's own player
 * lives behind it anyway.
 *
 * There is no permalink field in the API response — the URL has to be constructed from the id.
 */
export function apolloCallUrl(callId: string): string {
  return `https://app.apollo.io/#/phone-calls/${callId}`;
}

export interface ApolloCall {
  id: string;
  duration: number | null;
  recording_url: string | null;
  conversation_id: string | null;
  phone_call_outcome_id: string | null;
  start_time: string | null;
  status: string | null;
  contact?: {
    name?: string;
    first_name?: string;
    last_name?: string;
    title?: string;
    email?: string;
    organization_name?: string;
  } | null;
  account_id?: string | null;
  account?: { name?: string; id?: string; domain?: string } | null;
}

/** A call joined to its human-readable disposition name. */
export interface TargetCall extends ApolloCall {
  disposition: string;
  contactName: string;
  accountName: string;
  /**
   * Three independent grouping signals, matched with OR rather than collapsed into one key.
   *
   * A single key always splits somebody, because no one field is populated on every call:
   * No single field is populated on every call. Choosing a winner is what
   * broke one account: one contact resolved to an id, another to a name, and the same
   * company never grouped. Storing all three and matching on ANY of them means a contact groups
   * as long as it shares *something* with a prior call.
   */
  accountId: string | null;
  accountNameKey: string | null;
  emailDomain: string | null;
}

/**
 * Free-mail and generic hosts must never group people — two prospects at unrelated sites who
 * both used a personal address would otherwise be merged into one "account".
 */
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "protonmail.com",
  "proton.me", "gmx.com", "zoho.com", "mail.com", "comcast.net", "verizon.net", "att.net",
  "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "earthlink.net",
]);

export function emailDomainFor(email: string | null | undefined): string | null {
  if (!email || !email.includes("@")) return null;
  const domain = email.split("@").pop()?.trim().toLowerCase() ?? "";
  if (!domain || !domain.includes(".")) return null;
  return GENERIC_EMAIL_DOMAINS.has(domain) ? null : domain;
}

/**
 * Normalize a company name into a grouping key: lowercase, drop punctuation, drop the legal and
 * generic suffixes that vary between records ("Bright Path Clinical Studies" vs "Bright Path Clinical
 * Studies, LLC" must land on the same key).
 */
export function normalizeAccountName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,''`"()]/g, " ")
    .replace(/\b(llc|l\.l\.c|inc|incorporated|corp|corporation|ltd|limited|co|pllc|pc|pa|plc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function accountNameKeyFor(accountName: string): string | null {
  const norm = normalizeAccountName(accountName);
  return norm || null;
}

async function post<T>(env: Env, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.APOLLO_SALES_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`apollo ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Disposition id -> display name.
 *
 * Apollo returns only `phone_call_outcome_id` on a call; the mapping lives in the search
 * response's faceting block, which comes back free on any search. `per_page: 1` keeps it cheap.
 */
export async function fetchDispositionMap(env: Env): Promise<Map<string, string>> {
  const data = await post<{
    faceting?: { phone_call_stats_facets?: Array<{ value: string; display_name: string }> };
  }>(env, "/phone_calls/search", { per_page: 1, page: 1 });

  const facets = data.faceting?.phone_call_stats_facets ?? [];
  return new Map(facets.map((f) => [f.value, f.display_name]));
}

/** YYYY-MM-DD, `days` before now. Apollo's date_range is date-granular. */
export function lookbackDate(days: number, now = new Date()): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Every call in [since, today] that has a recording, whatever its disposition or length.
 * (Yoshi removed the disposition and minimum-duration filters on 2026-11-10.)
 *
 * Calls with no recording are left out of the ledger entirely rather than parked as
 * `no_audio`: most dials never record, and queuing them would eat every MAX_PER_RUN
 * slot on retries. A recording that uploads late is still caught — the next run's sweep of
 * the lookback window sees it and inserts the call then.
 *
 * Paginates to exhaustion. A 4-day window is normally 1-2 pages; the cap is a backstop
 * against a runaway loop, not an expected limit.
 */
export async function fetchTargetCalls(
  env: Env,
  since: string,
  until: string,
  maxPages = 20,
): Promise<TargetCall[]> {
  const dispositions = await fetchDispositionMap(env);
  const out: TargetCall[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const data = await post<{ phone_calls?: ApolloCall[] }>(env, "/phone_calls/search", {
      per_page: 100,
      page,
      date_range: { min: since, max: until },
    });
    const batch = data.phone_calls ?? [];

    for (const call of batch) {
      if (!call.recording_url) continue;
      // Notion rejects an empty select name, and many calls are logged with no disposition.
      const disposition = dispositions.get(call.phone_call_outcome_id ?? "") || "No Disposition";
      const accountName = call.account?.name ?? call.contact?.organization_name ?? "";
      out.push({
        ...call,
        disposition,
        contactName: contactName(call),
        accountName,
        accountId: call.account_id ?? call.account?.id ?? null,
        accountNameKey: accountNameKeyFor(accountName),
        // account.domain is the company's own domain and is the stronger signal when present;
        // the contact's email domain covers the cases where Apollo has no Account record.
        emailDomain:
          emailDomainFor(call.contact?.email) ??
          (call.account?.domain ? emailDomainFor(`x@${call.account.domain}`) : null),
      });
    }

    if (batch.length < 100) break;
  }

  return out;
}

/**
 * A single call by id — used right before transcription to get a freshly-signed recording_url.
 * Returns null if Apollo still has no recording (audio not uploaded).
 */
export async function fetchFreshRecordingUrl(env: Env, callId: string): Promise<string | null> {
  const res = await fetch(`${BASE}/phone_calls/${callId}`, {
    headers: { "x-api-key": env.APOLLO_SALES_API_KEY },
  });
  if (!res.ok) throw new Error(`apollo GET /phone_calls/${callId} -> ${res.status}`);
  const data = (await res.json()) as { phone_call?: ApolloCall } & ApolloCall;
  return (data.phone_call ?? data)?.recording_url ?? null;
}

function contactName(call: ApolloCall): string {
  const c = call.contact;
  if (!c) return "";
  if (c.name) return c.name.trim();
  return [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
}
