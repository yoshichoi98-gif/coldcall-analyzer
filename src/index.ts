// Cold call recording analyzer.
//
// Nightly (Mon-Fri, 3am PT) the cron pulls the day's Apollo cold calls in the seven target
// dispositions, transcribes them speaker-separated via AssemblyAI, works out which stereo
// channel is the rep, runs a Claude analysis pass, and writes one page per call to Notion.
//
// Routes:
//   GET /            health check
//   GET /run?token=  run the same pipeline the cron runs, on demand (for testing / catch-up)
//   GET /status?token=  ledger state histogram, no work performed
//   GET /reanalyze?token=  re-run the current analysis prompt over calls analyzed under an older
//                          one (batched; repeat until `outstanding` reaches 0)

import type { Env } from "./env.ts";
import { runOnce } from "./run.ts";
import { reanalyzeBatch, SCHEMA_MARKER } from "./reanalyze.ts";
import { countMissingInsightField, stateCounts } from "./db.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "coldcall-analyzer" });
    }

    if (url.pathname === "/status") {
      if (!tokenOk(url, env)) return text("forbidden", 403);
      return json({
        states: await stateCounts(env.DB),
        awaiting_reanalysis: await countMissingInsightField(env.DB, SCHEMA_MARKER),
      });
    }

    if (url.pathname === "/run") {
      if (!tokenOk(url, env)) return text("forbidden", 403);

      // ?limit=N caps how many calls this pass processes — useful for eyeballing output on one
      // call before committing a batch, or drip-feeding a large catch-up sweep.
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit ? Number(rawLimit) : undefined;
      if (rawLimit && !Number.isFinite(limit)) return text("limit must be a number", 400);

      // ?async=1 returns immediately and finishes in the background — useful when a catch-up
      // sweep would outlast the HTTP request.
      if (url.searchParams.get("async") === "1") {
        ctx.waitUntil(
          runOnce(env, limit).catch((err) =>
            console.error(`[run] failed: ${err instanceof Error ? err.message : err}`),
          ),
        );
        return json({ started: true });
      }

      try {
        return json(await runOnce(env, limit));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[run] failed: ${msg}`);
        return json({ status: "error", detail: msg }, 500);
      }
    }

    // Re-run the CURRENT analysis prompt over calls analyzed under an older one. Batched and
    // repeatable: each pass reports how many rows are still outstanding, and a row drops out of
    // the queue as soon as its new analysis lands, so this is just fired until it reports zero.
    if (url.pathname === "/reanalyze") {
      if (!tokenOk(url, env)) return text("forbidden", 403);

      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit ? Number(rawLimit) : undefined;
      if (rawLimit && !Number.isFinite(limit)) return text("limit must be a number", 400);

      if (url.searchParams.get("async") === "1") {
        ctx.waitUntil(
          reanalyzeBatch(env, limit).catch((err) =>
            console.error(`[reanalyze] failed: ${err instanceof Error ? err.message : err}`),
          ),
        );
        return json({ started: true });
      }

      try {
        return json(await reanalyzeBatch(env, limit));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[reanalyze] failed: ${msg}`);
        return json({ status: "error", detail: msg }, 500);
      }
    }

    return text("not found", 404);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runOnce(env).catch((err) =>
        console.error(`[cron] run failed: ${err instanceof Error ? err.message : err}`),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

function tokenOk(url: URL, env: Env): boolean {
  const t = url.searchParams.get("token");
  return !!t && !!env.MANUAL_RUN_TOKEN && t === env.MANUAL_RUN_TOKEN;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}
