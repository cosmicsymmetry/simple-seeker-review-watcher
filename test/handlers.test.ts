import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { state } from "./fixtures";

function statusEnv(): Env {
  const kv = {
    getWithMetadata: vi.fn(async () => ({
      value: state({ summary_total: 42, rating: 4.3 }),
      metadata: { lastRun: "2026-08-24T12:00:00.000Z" },
      cacheStatus: null,
    })),
  } as unknown as KVNamespace;
  return {
    REVIEW_WATCH: kv,
    PORTAL_PASSWORD: "must-not-appear",
    PORTAL_JWT: "must-not-appear-either",
    TELEGRAM_BOT_TOKEN: "also-secret",
  };
}

describe("fetch handler", () => {
  it("returns only public status at GET /", async () => {
    const response = await worker.fetch(new Request("https://example.test/"), statusEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("last run: 2026-08-24T12:00:00.000Z");
    expect(body).toContain("total reviews: 42");
    expect(body).toContain("average rating: 4.3");
    expect(body).not.toMatch(/must-not-appear|also-secret/);
  });

  it("hides POST /run when TRIGGER_TOKEN is unset", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/run", { method: "POST" }),
      statusEnv(),
    );
    expect(response.status).toBe(404);
  });

  it("rejects a wrong production trigger token", async () => {
    const env = { ...statusEnv(), TRIGGER_TOKEN: "correct-token" };
    const response = await worker.fetch(
      new Request("https://example.test/run", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("returns 500 when an authenticated manual run throws unexpectedly", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const kv = {
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
      get: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
    } as unknown as KVNamespace;
    const response = await worker.fetch(
      new Request("https://example.test/run", {
        method: "POST",
        headers: { authorization: "Bearer correct-token" },
      }),
      { REVIEW_WATCH: kv, TRIGGER_TOKEN: "correct-token" },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it("returns 404 for every other route", async () => {
    const response = await worker.fetch(new Request("https://example.test/nope"), statusEnv());
    expect(response.status).toBe(404);
  });
});
