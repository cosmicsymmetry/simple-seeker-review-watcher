import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPoll, runScheduled, type RunDependencies } from "../src/index";
import { PortalError } from "../src/portal";
import type { Env, ReviewState, StateRecord } from "../src/types";
import { review, state, summary } from "./fixtures";

function harness(initial: StateRecord, credentials = true) {
  let record = structuredClone(initial);
  let authBroken = false;
  const notifications: Array<{ title: string; body: string }> = [];
  const poll = vi.fn<RunDependencies["pollPortal"]>().mockResolvedValue({
    summary: summary(),
    reviews: [review()],
  });
  const mint = vi.fn<RunDependencies["mintJwt"]>().mockResolvedValue("fresh-jwt");
  const saveJwtMock = vi.fn<RunDependencies["saveJwt"]>().mockResolvedValue(undefined);

  const deps: Partial<RunDependencies> = {
    loadState: vi.fn(async () => structuredClone(record)),
    saveState: vi.fn(async (_kv, next, lastRun) => {
      record = { state: structuredClone(next), lastRun };
    }),
    loadAuthBroken: vi.fn(async () => authBroken),
    saveAuthBroken: vi.fn(async (_kv, broken) => {
      authBroken = broken;
    }),
    loadJwt: vi.fn(async () => "cached-jwt"),
    saveJwt: saveJwtMock,
    mintJwt: mint,
    pollPortal: poll,
    notify: vi.fn(async (_token, _chatId, title, body) => {
      notifications.push({ title, body });
      return true;
    }),
    now: () => new Date("2026-08-24T12:00:00.000Z"),
  };
  const env = {
    REVIEW_WATCH: {} as KVNamespace,
    PORTAL_EMAIL: credentials ? "publisher@example.com" : undefined,
    PORTAL_PASSWORD: credentials ? "password" : undefined,
    TELEGRAM_BOT_TOKEN: "fake-token",
    TELEGRAM_CHAT_ID: "123",
  } satisfies Env;

  return {
    deps,
    env,
    poll,
    mint,
    saveJwtMock,
    notifications,
    getRecord: () => record,
    getAuthBroken: () => authBroken,
  };
}

describe("poll orchestration", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => undefined));

  it("does not notify on first-run seeding", async () => {
    const h = harness({ state: null, lastRun: null });
    const outcome = await runPoll(h.env, h.deps);
    expect(outcome).toMatchObject({ ok: true, seeded: true, eventCount: 0 });
    expect(h.notifications).toEqual([]);
    expect(h.getRecord().state?.seen.r1).toBeDefined();
  });

  it("re-mints and retries once after a failed poll", async () => {
    const h = harness({ state: state(), lastRun: "earlier" });
    h.poll
      .mockRejectedValueOnce(new PortalError("expired"))
      .mockResolvedValueOnce({ summary: summary(), reviews: [review()] });
    await expect(runPoll(h.env, h.deps)).resolves.toMatchObject({ ok: true });
    expect(h.poll).toHaveBeenCalledTimes(2);
    expect(h.mint).toHaveBeenCalledTimes(1);
    expect(h.saveJwtMock).toHaveBeenCalledWith(h.env.REVIEW_WATCH, "fresh-jwt");
    expect(h.poll.mock.calls[1][1]).toBe("fresh-jwt");
  });

  it("stops after exactly one retry", async () => {
    const h = harness({ state: state(), lastRun: "earlier" });
    h.poll.mockRejectedValue(new PortalError("still unavailable"));
    const outcome = await runPoll(h.env, h.deps);
    expect(outcome.ok).toBe(false);
    expect(h.poll).toHaveBeenCalledTimes(2);
    expect(h.mint).toHaveBeenCalledTimes(1);
  });

  it("does not retry when credentials are absent", async () => {
    const h = harness({ state: state(), lastRun: "earlier" }, false);
    h.poll.mockRejectedValue(new PortalError("expired"));
    const outcome = await runPoll(h.env, h.deps);
    expect(outcome.ok).toBe(false);
    expect(h.poll).toHaveBeenCalledTimes(1);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("alerts exactly once when the first run fails and repeated failures stay quiet", async () => {
    const h = harness({ state: null, lastRun: null }, false);
    h.poll.mockRejectedValue(new PortalError("portal down"));

    await runPoll(h.env, h.deps);
    await runPoll(h.env, h.deps);
    expect(h.notifications.map((item) => item.title)).toEqual([
      "Seeker Review Watch: portal unreachable",
    ]);
    expect(h.getRecord().state).toBeNull();
    expect(h.getAuthBroken()).toBe(true);
  });

  it("sends recovery but no review alert when the recovery run seeds state", async () => {
    const h = harness({ state: null, lastRun: null }, false);
    h.poll.mockRejectedValue(new PortalError("portal down"));
    await runPoll(h.env, h.deps);

    h.poll.mockReset().mockResolvedValue({ summary: summary(), reviews: [review()] });
    const outcome = await runPoll(h.env, h.deps);
    expect(outcome).toMatchObject({ ok: true, seeded: true, eventCount: 0 });
    expect(h.notifications.map((item) => item.title)).toEqual([
      "Seeker Review Watch: portal unreachable",
      "Seeker Review Watch: portal access recovered",
    ]);
    expect(h.notifications.some((item) => item.title.includes("review change(s)"))).toBe(false);
    expect(h.getRecord().state?.seen.r1).toBeDefined();
    expect(h.getAuthBroken()).toBe(false);
  });

  it("sends at most ten event lines but reports the full event count", async () => {
    const manySeen: ReviewState = state({ summary_total: 0, seen: {} });
    const h = harness({ state: manySeen, lastRun: "earlier" });
    const reviews = Array.from({ length: 12 }, (_, index) => review({ id: `r${index}` }));
    h.poll.mockResolvedValue({
      summary: summary({ reviewsByRating: [0, 0, 0, 12, 0] }),
      reviews,
    });
    await runPoll(h.env, h.deps);
    expect(h.notifications[0].title).toContain("12 review change(s)");
    expect(h.notifications[0].body).toContain("…and 2 more");
  });

  it("contains unexpected scheduled failures and logs their class and message", async () => {
    await expect(
      runScheduled(harness({ state: null, lastRun: null }).env, async () => {
        throw new TypeError("malformed review payload");
      }),
    ).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("scheduled run caught: TypeError: malformed review payload"),
    );
  });
});
