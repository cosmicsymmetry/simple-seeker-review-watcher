import type { ReviewState, StateRecord } from "./types";

const STATE_KEY = "state";
const JWT_KEY = "jwt";
const AUTH_BROKEN_KEY = "auth_broken";

interface StateMetadata {
  lastRun?: string;
}

export async function loadState(kv: KVNamespace): Promise<StateRecord> {
  try {
    const record = await kv.getWithMetadata<ReviewState, StateMetadata>(STATE_KEY, "json");
    return {
      state: record.value,
      lastRun: record.metadata?.lastRun || null,
    };
  } catch {
    console.log(`${new Date().toISOString()} state unreadable; reseeding`);
    return { state: null, lastRun: null };
  }
}

export async function saveState(
  kv: KVNamespace,
  state: ReviewState,
  lastRun: string | null,
): Promise<void> {
  // KV is eventually consistent. At a 20-minute cadence, a brief stale read can
  // at worst repeat one alert. If the interval ever drops substantially, use a
  // Durable Object to serialize polls and provide strongly consistent state.
  await kv.put(STATE_KEY, JSON.stringify(state), {
    metadata: lastRun ? { lastRun } : undefined,
  });
}

export async function loadJwt(kv: KVNamespace): Promise<string | null> {
  const jwt = await kv.get(JWT_KEY);
  return jwt?.trim() || null;
}

export async function saveJwt(kv: KVNamespace, jwt: string): Promise<void> {
  await kv.put(JWT_KEY, jwt);
}

export async function loadAuthBroken(kv: KVNamespace): Promise<boolean> {
  return (await kv.get(AUTH_BROKEN_KEY)) === "true";
}

export async function saveAuthBroken(kv: KVNamespace, broken: boolean): Promise<void> {
  await kv.put(AUTH_BROKEN_KEY, broken ? "true" : "false");
}
