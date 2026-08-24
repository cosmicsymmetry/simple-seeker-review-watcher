import { deriveChanges, formatAlert } from "./diff";
import { DappError, mintJwt, pollPortal } from "./portal";
import {
  loadAuthBroken,
  loadJwt,
  loadState,
  saveAuthBroken,
  saveJwt,
  saveState,
} from "./state";
import { sendTelegram, TelegramError } from "./telegram";
import type { Env, PollResult, ReviewState, StateRecord } from "./types";

export interface RunOutcome {
  ok: boolean;
  seeded?: boolean;
  eventCount?: number;
}

export interface RunDependencies {
  loadState: (kv: KVNamespace) => Promise<StateRecord>;
  saveState: (kv: KVNamespace, state: ReviewState, lastRun: string | null) => Promise<void>;
  loadAuthBroken: (kv: KVNamespace) => Promise<boolean>;
  saveAuthBroken: (kv: KVNamespace, broken: boolean) => Promise<void>;
  loadJwt: (kv: KVNamespace) => Promise<string | null>;
  saveJwt: (kv: KVNamespace, jwt: string) => Promise<void>;
  mintJwt: (email: string | undefined, password: string | undefined) => Promise<string>;
  pollPortal: (env: Pick<Env, "DAPP_ID">, jwt: string) => Promise<PollResult>;
  notify: (
    token: string | undefined,
    chatId: string | undefined,
    title: string,
    body: string,
  ) => Promise<boolean>;
  now: () => Date;
}

const defaultDependencies: RunDependencies = {
  loadState,
  saveState,
  loadAuthBroken,
  saveAuthBroken,
  loadJwt,
  saveJwt,
  mintJwt,
  pollPortal,
  notify: sendTelegram,
  now: () => new Date(),
};

function log(message: string, now: () => Date = () => new Date()): void {
  console.log(`${now().toISOString()} ${message}`);
}

function errorDescription(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}

async function notifySafely(
  env: Env,
  title: string,
  body: string,
  deps: RunDependencies,
): Promise<void> {
  try {
    const sent = await deps.notify(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      title,
      body,
    );
    if (!sent) log("notification skipped: Telegram secrets are not both configured", deps.now);
  } catch (error) {
    // Telegram's URL contains the bot token, so log only class/status, never
    // an exception message or response body that might echo the URL.
    if (error instanceof TelegramError) {
      log(
        `telegram failed (${error.name}${error.status === null ? "" : `, HTTP ${error.status}`})`,
        deps.now,
      );
    } else {
      const type = error instanceof Error ? error.name : typeof error;
      log(`telegram failed (${type})`, deps.now);
    }
  }
}

async function markPollFailure(
  env: Env,
  authBroken: boolean,
  error: unknown,
  haveCredentials: boolean,
  deps: RunDependencies,
): Promise<RunOutcome> {
  if (!authBroken) {
    const hint = haveCredentials
      ? "Auto re-login failed. Check PORTAL_EMAIL and PORTAL_PASSWORD, or the portal may be down or rate-limited."
      : "Set PORTAL_EMAIL and PORTAL_PASSWORD so the token can refresh, or provide a fresh PORTAL_JWT.";
    await notifySafely(
      env,
      "Seeker Review Watch: portal unreachable",
      `${errorDescription(error)}\n${hint}`,
      deps,
    );
    await deps.saveAuthBroken(env.REVIEW_WATCH, true);
  }
  log(`poll failed after self-heal attempt: ${errorDescription(error)}`, deps.now);
  return { ok: false };
}

export async function runPoll(
  env: Env,
  overrides: Partial<RunDependencies> = {},
): Promise<RunOutcome> {
  const deps: RunDependencies = { ...defaultDependencies, ...overrides };
  const [record, authBroken] = await Promise.all([
    deps.loadState(env.REVIEW_WATCH),
    deps.loadAuthBroken(env.REVIEW_WATCH),
  ]);
  const haveCredentials = Boolean(env.PORTAL_EMAIL && env.PORTAL_PASSWORD);

  let jwt: string;
  try {
    const cached = await deps.loadJwt(env.REVIEW_WATCH);
    if (cached) {
      jwt = cached;
    } else if (env.PORTAL_JWT) {
      jwt = env.PORTAL_JWT;
    } else {
      jwt = await deps.mintJwt(env.PORTAL_EMAIL, env.PORTAL_PASSWORD);
      await deps.saveJwt(env.REVIEW_WATCH, jwt);
    }
  } catch (error) {
    return markPollFailure(env, authBroken, error, haveCredentials, deps);
  }

  let result: PollResult;
  try {
    result = await deps.pollPortal(env, jwt);
  } catch (firstError) {
    if (firstError instanceof DappError || !haveCredentials) {
      return markPollFailure(env, authBroken, firstError, haveCredentials, deps);
    }

    // Exactly one fresh login and one retry. A Left can mean rate limiting, so
    // never loop on it or diagnose it as a bad password from this response alone.
    try {
      log(`poll failed (${errorDescription(firstError)}); attempting re-login`, deps.now);
      jwt = await deps.mintJwt(env.PORTAL_EMAIL, env.PORTAL_PASSWORD);
      await deps.saveJwt(env.REVIEW_WATCH, jwt);
      result = await deps.pollPortal(env, jwt);
      log("re-login succeeded; token refreshed", deps.now);
    } catch (retryError) {
      return markPollFailure(env, authBroken, retryError, haveCredentials, deps);
    }
  }

  const diff = deriveChanges(record.state, result.summary, result.reviews);

  if (authBroken) {
    await deps.saveAuthBroken(env.REVIEW_WATCH, false);
    await notifySafely(
      env,
      "Seeker Review Watch: portal access recovered",
      "Polling resumed.",
      deps,
    );
  }

  if (diff.seeded) {
    log(
      `seeded state: ${diff.state.summary_total} total reviews, window of ${Object.keys(diff.state.seen).length}`,
      deps.now,
    );
  } else if (diff.events.length > 0) {
    const alert = formatAlert(diff.events, result.summary.rating);
    await notifySafely(env, alert.title, alert.body, deps);
  } else {
    log(
      `no changes (${diff.state.summary_total} total, ${diff.state.reply_count} replies)`,
      deps.now,
    );
  }

  await deps.saveState(env.REVIEW_WATCH, diff.state, deps.now().toISOString());
  return { ok: true, seeded: diff.seeded, eventCount: diff.events.length };
}

export async function runScheduled(
  env: Env,
  poll: (env: Env) => Promise<RunOutcome> = runPoll,
): Promise<void> {
  try {
    await poll(env);
  } catch (error) {
    // Cron invocations must settle normally. Manual runs retain a non-2xx
    // response so unexpected failures remain visible to callers.
    log(`scheduled run caught: ${errorDescription(error)}`);
  }
}

async function statusResponse(env: Env): Promise<Response> {
  const record = await loadState(env.REVIEW_WATCH);
  const state = record.state;
  const lines = [
    "simple-seeker-review-watcher",
    `last run: ${record.lastRun || "never"}`,
    `total reviews: ${state?.summary_total ?? "unknown"}`,
    `average rating: ${state?.rating ?? "unknown"}`,
  ];
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export default {
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return statusResponse(env);

    if (request.method === "POST" && url.pathname === "/run") {
      if (!env.TRIGGER_TOKEN) return new Response("Not found\n", { status: 404 });
      if (request.headers.get("authorization") !== `Bearer ${env.TRIGGER_TOKEN}`) {
        return new Response("Unauthorized\n", { status: 401 });
      }
      try {
        const outcome = await runPoll(env);
        return Response.json(outcome, { status: outcome.ok ? 200 : 503 });
      } catch (error) {
        log(`manual run caught: ${errorDescription(error)}`);
        return Response.json({ ok: false }, { status: 500 });
      }
    }

    return new Response("Not found\n", { status: 404 });
  },
};
