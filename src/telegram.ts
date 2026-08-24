type Fetch = typeof fetch;

export class TelegramError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super(status === null ? "Telegram network error" : `Telegram HTTP ${status}`);
    this.name = "TelegramError";
    this.status = status;
  }
}

export async function sendTelegram(
  botToken: string | undefined,
  chatId: string | undefined,
  title: string,
  body: string,
  fetchFn: Fetch = fetch,
): Promise<boolean> {
  if (!botToken || !chatId) return false;

  let response: Response;
  try {
    response = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chat_id: chatId, text: `${title}\n\n${body}` }),
    });
  } catch {
    // Never include the caught error text: runtimes can echo the token-bearing URL.
    throw new TelegramError(null);
  }

  if (!response.ok) {
    // The status is enough to diagnose common 400/401 failures without reading
    // a response that may include request details.
    throw new TelegramError(response.status);
  }
  return true;
}
