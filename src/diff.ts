import type {
  PortalReview,
  ReviewState,
  ReviewSummary,
  SeenReview,
} from "./types";

export interface DiffResult {
  events: string[];
  state: ReviewState;
  seeded: boolean;
}

export interface AlertText {
  title: string;
  body: string;
}

export function brief(review: PortalReview, limit = 120): string {
  const who = review.domain || "anonymous";
  const text = (review.review || "").replace(/[\r\n]+/g, " ").trim() || "(rating only)";
  return `${review.rating}★ ${who}: ${text.slice(0, limit)}`;
}

export function snapshot(reviews: PortalReview[]): Record<string, SeenReview> {
  return Object.fromEntries(
    reviews.map((review) => [
      review.id,
      {
        rating: review.rating,
        review: review.review ?? null,
        reply: review.publisherReply?.review ?? null,
        domain: review.domain ?? null,
        createdAt: review.createdAt,
      },
    ]),
  );
}

export function deriveChanges(
  previous: ReviewState | null,
  summary: ReviewSummary,
  reviews: PortalReview[],
): DiffResult {
  const total = summary.reviewsByRating.reduce((sum, count) => sum + count, 0);
  const current = snapshot(reviews);

  if (previous === null) {
    return {
      events: [],
      seeded: true,
      state: {
        summary_total: total,
        reply_count: summary.replyCount,
        rating: summary.rating,
        seen: current,
      },
    };
  }

  const events: string[] = [];
  for (const review of reviews) {
    const old = previous.seen[review.id];
    const next = current[review.id];
    if (old === undefined) {
      events.push(`NEW  ${brief(review)}`);
      continue;
    }

    if (old.rating !== next.rating || (old.review || "") !== (next.review || "")) {
      events.push(`EDIT ${brief(review)} (was ${old.rating}★)`);
    }

    if ((old.reply || "") !== (next.reply || "")) {
      let tag = next.reply ? "REPLY CHANGED on" : "REPLY REMOVED on";
      if (!old.reply && next.reply) tag = "REPLY ADDED on";
      events.push(`${tag} ${brief(review, 60)}`);
    }
  }

  const knownNew = reviews.filter((review) => previous.seen[review.id] === undefined).length;
  if (total !== previous.summary_total + knownNew) {
    events.push(
      `Summary drift: total ${previous.summary_total} -> ${total} ` +
        `(only ${knownNew} new in window; something older changed)`,
    );
  }

  if (
    summary.replyCount !== previous.reply_count &&
    !events.some((event) => event.includes("REPLY"))
  ) {
    events.push(`Reply count ${previous.reply_count} -> ${summary.replyCount} (outside window)`);
  }

  return {
    events,
    seeded: false,
    state: {
      summary_total: total,
      reply_count: summary.replyCount,
      rating: summary.rating,
      seen: { ...previous.seen, ...current },
    },
  };
}

export function formatAlert(events: string[], rating: number | null): AlertText {
  const displayed = events.slice(0, 10);
  const remainder = events.length - displayed.length;
  return {
    title: `Seeker Review Watch: ${events.length} review change(s), avg ${rating ?? "unknown"}`,
    body: displayed.join("\n") + (remainder > 0 ? `\n…and ${remainder} more` : ""),
  };
}
