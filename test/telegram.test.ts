import { describe, expect, it, vi } from "vitest";
import { sendTelegram, TelegramError } from "../src/telegram";

describe("Telegram", () => {
  it("posts form-encoded text to the bot API", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok", { status: 200 }));
    await expect(
      sendTelegram("123:FAKE", "456", "Alert title", "Alert body", fetchMock),
    ).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:FAKE/sendMessage");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("chat_id")).toBe("456");
    expect(body.get("text")).toBe("Alert title\n\nAlert body");
  });

  it("returns false when either Telegram secret is missing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(sendTelegram(undefined, "456", "title", "body", fetchMock)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes only the status on HTTP failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"description":"bad chat"}', { status: 400 }),
    );
    const error = await sendTelegram("secret-token", "bad", "title", "body", fetchMock).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({ status: 400, message: "Telegram HTTP 400" });
    expect(String(error)).not.toContain("secret-token");
  });
});
