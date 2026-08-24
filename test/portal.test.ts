import { describe, expect, it, vi } from "vitest";
import {
  extractJwt,
  listDapps,
  mintJwt,
  normalizeDapps,
  parseEither,
  pollPortal,
  PortalError,
  resolveDappId,
  USER_AGENT,
} from "../src/portal";

const right = <T>(value: T) => ({ result: { data: { _tag: "Right", right: value } } });

describe("Either parsing", () => {
  it("extracts Right", () => expect(parseEither(right({ value: 1 }), "test")).toEqual({ value: 1 }));

  it("rejects Left without claiming credentials are wrong", () => {
    expect(() =>
      parseEither({ result: { data: { _tag: "Left", left: { message: "limited" } } } }, "signIn"),
    ).toThrow(/returned Left/);
  });

  it("reports a tRPC transport error", () => {
    expect(() => parseEither({ error: { json: { message: "Internal server error" } } }, "signIn"))
      .toThrow(/Internal server error/);
  });

  it("rejects a successful signIn with no jwt", () => {
    expect(() => extractJwt(right({ id: "u1" }))).toThrow(/no jwt/);
  });

  it("tolerates the legacy bare payload", () => {
    expect(extractJwt({ result: { data: { jwt: "token" } } })).toBe("token");
  });
});

describe("portal requests", () => {
  it("posts credentials without exposing them elsewhere", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(right({ jwt: "fresh" })));
    await expect(mintJwt("publisher@example.com", "secret", fetchMock)).resolves.toBe("fresh");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://publish.solanamobile.com/api/trpc/signIn");
    expect(init?.body).toBe('{"email":"publisher@example.com","password":"secret"}');
    expect(new Headers(init?.headers).get("user-agent")).toBe(USER_AGENT);
  });

  it("calls listDapps with no input query parameter", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(right([])));
    await listDapps("jwt", fetchMock);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://publish.solanamobile.com/api/trpc/listDapps",
    );
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("input");
  });

  it("fetches exactly three newest pages and pauses between them", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const parsed = JSON.parse(url.searchParams.get("input")!);
      return Response.json(
        right({
          summary: { rating: 4, replyCount: 0, reviewsByRating: [0, 0, 0, 1, 0] },
          reviews: [{ id: `r${parsed.page}`, rating: 4, createdAt: "now" }],
        }),
      );
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await pollPortal({ DAPP_ID: "d1" }, "jwt", fetchMock, sleep);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.reviews.map((review) => review.id)).toEqual(["r1", "r2", "r3"]);
    for (const call of fetchMock.mock.calls) {
      const input = JSON.parse(new URL(String(call[0])).searchParams.get("input")!);
      expect(input).toMatchObject({ dappId: "d1", first: 10, sortBy: "newest" });
    }
  });
});

describe("dApp normalization and selection", () => {
  it("normalizes confirmed and alternate field names", () => {
    expect(
      normalizeDapps(
        right([
          { id: "one", dappName: "Real name", packageName: "com.real" },
          { dappId: "two", name: "Alternate name", androidPackage: "com.alt" },
        ]),
      ),
    ).toEqual([
      { id: "one", label: "Real name" },
      { id: "two", label: "Alternate name" },
    ]);
  });

  it("selects one dApp", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(right([{ id: "only", dappName: "Only app" }])),
    );
    await expect(resolveDappId(undefined, "jwt", fetchMock)).resolves.toBe("only");
  });

  it("errors for zero dApps", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(right([])));
    await expect(resolveDappId(undefined, "jwt", fetchMock)).rejects.toThrow(/no dApps/);
  });

  it("names every choice when there are multiple dApps", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(right([{ id: "1", dappName: "Alpha" }, { id: "2", name: "Beta" }])),
    );
    await expect(resolveDappId(undefined, "jwt", fetchMock)).rejects.toThrow(
      /Alpha=1, Beta=2/,
    );
  });

  it("rejects Left and malformed envelopes", () => {
    expect(() => normalizeDapps({ result: { data: { _tag: "Left" } } })).toThrow(PortalError);
    expect(() => normalizeDapps({ nope: true })).toThrow(PortalError);
  });
});
