export interface Env {
  REVIEW_WATCH: KVNamespace;
  DAPP_ID?: string;
  PORTAL_EMAIL?: string;
  PORTAL_PASSWORD?: string;
  PORTAL_JWT?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TRIGGER_TOKEN?: string;
}

export interface EitherRight<T> {
  _tag: "Right";
  right: T;
}

export interface EitherLeft {
  _tag: "Left";
  left?: unknown;
}

export type Either<T> = EitherRight<T> | EitherLeft;

export interface TrpcSuccess<T> {
  result: { data: Either<T> | T };
}

export interface TrpcTransportError {
  error: {
    json?: { message?: string };
    message?: string;
    [key: string]: unknown;
  };
}

export interface PortalDapp {
  id?: string;
  dappId?: string;
  dappName?: string;
  name?: string;
  packageName?: string;
  androidPackage?: string;
  title?: string;
  [key: string]: unknown;
}

export interface NormalizedDapp {
  id: string;
  label: string;
}

export interface PublisherReply {
  review?: string | null;
}

export interface PortalReview {
  id: string;
  rating: number;
  review?: string | null;
  domain?: string | null;
  createdAt: string;
  publisherReply?: PublisherReply | null;
}

export interface ReviewSummary {
  rating: number;
  replyCount: number;
  reviewsByRating: number[];
}

export interface ReviewsPage {
  summary: ReviewSummary;
  reviews: PortalReview[];
}

export interface PollResult {
  summary: ReviewSummary;
  reviews: PortalReview[];
}

export interface SeenReview {
  rating: number;
  review: string | null;
  reply: string | null;
  domain: string | null;
  createdAt: string;
}

export interface ReviewState {
  summary_total: number;
  reply_count: number;
  rating: number;
  seen: Record<string, SeenReview>;
}

export interface StateRecord {
  state: ReviewState | null;
  lastRun: string | null;
}
