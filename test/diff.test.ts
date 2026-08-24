import { describe, expect, it } from "vitest";
import { brief, deriveChanges, formatAlert } from "../src/diff";
import { review, state, summary } from "./fixtures";

describe("deriveChanges", () => {
  it("seeds a first run silently", () => {
    const result = deriveChanges(null, summary(), [review()]);
    expect(result.seeded).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.state.seen.r1.review).toBe("Useful app");
  });

  it("detects a new review", () => {
    const added = review({ id: "r2", rating: 5, review: "Great" });
    const result = deriveChanges(
      state(),
      summary({ reviewsByRating: [0, 0, 0, 1, 1] }),
      [review(), added],
    );
    expect(result.events).toEqual(["NEW  5★ alice.skr: Great"]);
  });

  it("detects rating and text edits and reports the old rating", () => {
    const result = deriveChanges(state(), summary({ rating: 5 }), [
      review({ rating: 5, review: "Much better" }),
    ]);
    expect(result.events[0]).toBe("EDIT 5★ alice.skr: Much better (was 4★)");
  });

  it.each([
    [null, "Thanks", "REPLY ADDED on"],
    ["Old reply", "New reply", "REPLY CHANGED on"],
    ["Old reply", null, "REPLY REMOVED on"],
  ])("detects reply transition %s -> %s", (oldReply, nextReply, label) => {
    const previous = state();
    previous.seen.r1.reply = oldReply;
    const result = deriveChanges(
      previous,
      summary({ replyCount: nextReply ? 1 : 0 }),
      [review({ publisherReply: nextReply ? { review: nextReply } : null })],
    );
    expect(result.events.some((event) => event.startsWith(label!))).toBe(true);
  });

  it("detects summary drift outside the window", () => {
    const result = deriveChanges(
      state(),
      summary({ reviewsByRating: [0, 0, 0, 2, 0] }),
      [review()],
    );
    expect(result.events).toEqual([
      "Summary drift: total 1 -> 2 (only 0 new in window; something older changed)",
    ]);
  });

  it("detects reply-count drift outside the window", () => {
    const result = deriveChanges(state(), summary({ replyCount: 1 }), [review()]);
    expect(result.events).toEqual(["Reply count 0 -> 1 (outside window)"]);
  });

  it("does not double-report reply-count drift when a reply event fired", () => {
    const result = deriveChanges(state(), summary({ replyCount: 1 }), [
      review({ publisherReply: { review: "Thanks" } }),
    ]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toContain("REPLY ADDED");
  });
});

describe("formatting", () => {
  it("collapses newlines, uses fallbacks, and truncates text", () => {
    const text = "x".repeat(130);
    expect(brief(review({ domain: null, review: ` ${text}\nsecond line` }))).toBe(
      `4★ anonymous: ${"x".repeat(120)}`,
    );
    expect(brief(review({ review: null }))).toContain("(rating only)");
  });

  it("truncates event output at ten", () => {
    const events = Array.from({ length: 12 }, (_, index) => `event ${index + 1}`);
    const alert = formatAlert(events, 3.7);
    expect(alert.title).toBe("Seeker Review Watch: 12 review change(s), avg 3.7");
    expect(alert.body).toContain("event 10");
    expect(alert.body).not.toContain("event 11");
    expect(alert.body).toMatch(/…and 2 more$/);
  });
});
