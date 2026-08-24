import { describe, expect, it, vi } from "vitest";
import {
  loadAuthBroken,
  loadJwt,
  loadState,
  saveAuthBroken,
  saveJwt,
  saveState,
} from "../src/state";
import { state } from "./fixtures";

describe("KV persistence", () => {
  it("reads state JSON and its last-run metadata", async () => {
    const expected = state();
    const getWithMetadata = vi.fn(async () => ({
      value: expected,
      metadata: { lastRun: "2026-08-24T12:00:00.000Z" },
      cacheStatus: null,
    }));
    const kv = { getWithMetadata } as unknown as KVNamespace;
    await expect(loadState(kv)).resolves.toEqual({
      state: expected,
      lastRun: "2026-08-24T12:00:00.000Z",
    });
    expect(getWithMetadata).toHaveBeenCalledWith("state", "json");
  });

  it("writes state, jwt, and the independent auth latch keys", async () => {
    const put = vi.fn(async (_key: string, _value: string, _options?: unknown) => undefined);
    const get = vi.fn(async () => " cached-token ");
    const kv = { put, get } as unknown as KVNamespace;
    const snapshot = state();
    await saveState(kv, snapshot, "2026-08-24T12:00:00.000Z");
    await saveJwt(kv, "new-token");
    await saveAuthBroken(kv, true);
    await expect(loadJwt(kv)).resolves.toBe("cached-token");
    expect(put.mock.calls.map((call) => call[0])).toEqual(["state", "jwt", "auth_broken"]);
    expect(JSON.parse(String(put.mock.calls[0][1]))).toEqual(snapshot);
    expect(put.mock.calls[0][2]).toEqual({
      metadata: { lastRun: "2026-08-24T12:00:00.000Z" },
    });
  });

  it("loads the latch without requiring a state value", async () => {
    const get = vi.fn(async (key: string) => (key === "auth_broken" ? "true" : null));
    const kv = { get } as unknown as KVNamespace;
    await expect(loadAuthBroken(kv)).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith("auth_broken");
  });
});
