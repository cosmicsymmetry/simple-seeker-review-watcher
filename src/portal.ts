import type {
  Env,
  NormalizedDapp,
  PollResult,
  PortalDapp,
  ReviewsPage,
} from "./types";

export const TRPC_BASE = "https://publish.solanamobile.com/api/trpc";
export const USER_AGENT =
  "simple-seeker-review-watcher (+https://github.com/cosmicsymmetry/simple-seeker-review-watcher)";
export const PAGE_COUNT = 3;
export const PAGE_PAUSE_MS = 3_000;

type Fetch = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

export class PortalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalError";
  }
}

export class DappError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DappError";
  }
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}

export function parseEither<T>(raw: unknown, procedure: string): T {
  if (typeof raw !== "object" || raw === null) {
    throw new PortalError(`unexpected ${procedure} response: ${describe(raw)}`);
  }

  const root = raw as Record<string, unknown>;
  if (root.error !== undefined && root.error !== null) {
    const error = root.error as { json?: { message?: string }; message?: string };
    const message = error?.json?.message || error?.message || describe(error);
    throw new PortalError(`${procedure} error: ${String(message).slice(0, 200)}`);
  }

  const result = root.result as { data?: unknown } | undefined;
  const data = result?.data;
  if (typeof data !== "object" || data === null) {
    throw new PortalError(`unexpected ${procedure} response: ${describe(raw)}`);
  }

  const envelope = data as { _tag?: string; right?: T; left?: unknown };
  if (envelope._tag === "Left") {
    throw new PortalError(`${procedure} returned Left: ${describe(envelope.left ?? envelope)}`);
  }
  if (envelope._tag === "Right") return envelope.right as T;
  return data as T;
}

async function readJson(response: Response, procedure: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PortalError(`${procedure} returned HTTP ${response.status} with invalid JSON`);
  }
}

export function extractJwt(raw: unknown): string {
  const payload = parseEither<{ jwt?: unknown }>(raw, "signIn");
  if (typeof payload.jwt !== "string" || payload.jwt.length === 0) {
    throw new PortalError(`signIn succeeded but carried no jwt: ${describe(payload)}`);
  }
  return payload.jwt;
}

export async function mintJwt(
  email: string | undefined,
  password: string | undefined,
  fetchFn: Fetch = fetch,
): Promise<string> {
  if (!email || !password) {
    throw new PortalError("email and password are both required to mint a JWT");
  }
  const response = await fetchFn(`${TRPC_BASE}/signIn`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ email, password }),
  });
  return extractJwt(await readJson(response, "signIn"));
}

export function normalizeDapps(raw: unknown): NormalizedDapp[] {
  let right = parseEither<PortalDapp[] | { dapps?: PortalDapp[]; items?: PortalDapp[] }>(
    raw,
    "listDapps",
  );
  if (!Array.isArray(right)) right = right.dapps || right.items || [];

  return right.flatMap((dapp) => {
    if (typeof dapp !== "object" || dapp === null) return [];
    const id = dapp.id || dapp.dappId;
    if (!id) return [];
    const label =
      dapp.name ||
      dapp.dappName ||
      dapp.title ||
      dapp.androidPackage ||
      dapp.packageName ||
      id;
    return [{ id, label }];
  });
}

export async function listDapps(jwt: string, fetchFn: Fetch = fetch): Promise<NormalizedDapp[]> {
  // Deliberately no `input` query parameter. The publisher SPA calls listDapps
  // with undefined input, which tRPC omits from the URL entirely.
  const response = await fetchFn(`${TRPC_BASE}/listDapps`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${jwt}`,
      "user-agent": USER_AGENT,
    },
  });
  return normalizeDapps(await readJson(response, "listDapps"));
}

export async function resolveDappId(
  configuredId: string | undefined,
  jwt: string,
  fetchFn: Fetch = fetch,
): Promise<string> {
  if (configuredId) return configuredId;
  const dapps = await listDapps(jwt, fetchFn);
  if (dapps.length === 1) return dapps[0].id;
  if (dapps.length === 0) {
    throw new DappError("no dApps found for this account; set DAPP_ID explicitly");
  }
  const listing = dapps.map((dapp) => `${dapp.label}=${dapp.id}`).join(", ");
  throw new DappError(`multiple dApps found; set DAPP_ID to one of: ${listing}`);
}

export async function fetchReviewsPage(
  jwt: string,
  dappId: string,
  page: number,
  fetchFn: Fetch = fetch,
): Promise<ReviewsPage> {
  const input = JSON.stringify({ dappId, first: 10, page, sortBy: "newest" });
  const url = new URL(`${TRPC_BASE}/getDappRatingsReviews`);
  url.searchParams.set("input", input);
  const response = await fetchFn(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${jwt}`,
      "user-agent": USER_AGENT,
    },
  });
  return parseEither<ReviewsPage>(await readJson(response, "getDappRatingsReviews"), "getDappRatingsReviews");
}

export async function pollPortal(
  env: Pick<Env, "DAPP_ID">,
  jwt: string,
  fetchFn: Fetch = fetch,
  sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<PollResult> {
  const dappId = await resolveDappId(env.DAPP_ID, jwt, fetchFn);
  let summary: ReviewsPage["summary"] | undefined;
  const reviews: ReviewsPage["reviews"] = [];

  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const result = await fetchReviewsPage(jwt, dappId, page, fetchFn);
    summary = result.summary;
    reviews.push(...result.reviews);
    if (page < PAGE_COUNT) await sleep(PAGE_PAUSE_MS);
  }

  if (!summary) throw new PortalError("getDappRatingsReviews returned no summary");
  return { summary, reviews };
}
