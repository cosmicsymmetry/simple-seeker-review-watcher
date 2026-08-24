import type { PortalReview, ReviewState, ReviewSummary } from "../src/types";

export function review(overrides: Partial<PortalReview> = {}): PortalReview {
  return {
    id: "r1",
    rating: 4,
    review: "Useful app",
    domain: "alice.skr",
    createdAt: "2026-08-20T10:00:00.000Z",
    publisherReply: null,
    ...overrides,
  };
}

export function summary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    rating: 4,
    replyCount: 0,
    reviewsByRating: [0, 0, 0, 1, 0],
    ...overrides,
  };
}

export function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    summary_total: 1,
    reply_count: 0,
    rating: 4,
    seen: {
      r1: {
        rating: 4,
        review: "Useful app",
        reply: null,
        domain: "alice.skr",
        createdAt: "2026-08-20T10:00:00.000Z",
      },
    },
    ...overrides,
  };
}
