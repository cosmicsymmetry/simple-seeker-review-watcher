# Simple Seeker Review Watcher

This Cloudflare Worker checks the newest Solana dApp Store reviews for your Seeker dApp and sends Telegram alerts for new reviews, edits, publisher reply changes, and changes outside the visible review window. It runs in your own Cloudflare account and is free at this schedule: the Worker runs about 72 times per day, compared with the Workers free tier allowance of 100,000 requests per day.

The first successful run saves the current state without sending a review-change alert. Later runs compare against that snapshot. If the first success follows an outage, it sends only the portal-recovery alert. The public `GET /` endpoint shows only the last successful run, total review count, and average rating.

## Prerequisites

- Node.js 22 or newer and npm
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A Solana Mobile publisher portal login for your own publisher account
- A Telegram bot and a Telegram chat where the bot can send messages

## Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot` and follow the prompts.
3. Copy the bot token. It looks like `123456789:AA...`. Treat it as a password.
4. Open your new bot and send it `/start`. A Telegram bot cannot message you until you have started a chat with it, so do not skip this step.
5. Open [@getmyid_bot](https://t.me/getmyid_bot) and send it any message. It replies with your numeric id. That number is `TELEGRAM_CHAT_ID`.

For a group, add both your bot and @getmyid_bot to the group and send a message there. @getmyid_bot reports the group's chat id, which begins with a minus sign, such as `-1001234567890`. Keep the minus sign. You can remove @getmyid_bot from the group afterwards, but your own bot has to stay.

Never paste your bot token into a chat, an issue, or a terminal transcript you plan to share. @getmyid_bot never needs it.

## Deploy step by step

Clone the repository and install its development dependencies:

```bash
git clone https://github.com/cosmicsymmetry/simple-seeker-review-watcher.git
cd simple-seeker-review-watcher
npm install
```

Log Wrangler into your Cloudflare account. The command opens a browser and ends with a successful login message:

```bash
npx wrangler login
```

Create the KV namespace that stores the review snapshot, cached JWT, and portal-outage latch:

```bash
npx wrangler kv namespace create REVIEW_WATCH
```

Wrangler prints a namespace id and usually a configuration block similar to:

```text
{ binding = "REVIEW_WATCH", id = "0123456789abcdef0123456789abcdef" }
```

Open `wrangler.jsonc` and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with that id. Do not use a preview id from a different namespace.

Set the required secrets. Wrangler prompts for each value and uploads it without writing it into `wrangler.jsonc`:

```bash
npx wrangler secret put PORTAL_EMAIL
npx wrangler secret put PORTAL_PASSWORD
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

Email plus password is the recommended portal setup because the Worker can mint and refresh its own JWT. As a manual bootstrap alternative, you can set a portal JWT:

```bash
npx wrangler secret put PORTAL_JWT
```

A manual JWT is optional and is tried only when KV has no cached JWT. Cached token resolution is `jwt` in KV, then `PORTAL_JWT`, then a new sign-in with email and password.

Deploy the Worker:

```bash
npx wrangler deploy
```

The output includes a `workers.dev` URL and confirms the cron trigger. Visiting that URL returns public status text. The cron runs every 20 minutes.

## Find your DAPP_ID

Leave `DAPP_ID` as an empty string in `wrangler.jsonc` when your publisher account has exactly one dApp. The Worker calls the publisher portal's authenticated `listDapps` procedure and selects that dApp automatically.

When the account has several dApps, the run log names every choice as `name=id`. Read it with:

```bash
npx wrangler tail
```

You will see a message similar to:

```text
DappError: multiple dApps found; set DAPP_ID to one of: App One=abc-123, App Two=def-456
```

Put the selected id in the `vars` section of `wrangler.jsonc`, then deploy again:

```jsonc
"vars": {
  "DAPP_ID": "abc-123"
}
```

`DAPP_ID` is an identifier, not a secret.

## Verify the Worker

Workers Logs are the log surface. Keep a live stream open during a scheduled run:

```bash
npx wrangler tail
```

The first successful poll should log `seeded state` and send no Telegram message. Later unchanged runs log `no changes`. Logs never include the password, bot token, or JWT.

To test a scheduled run locally, copy the example secrets and start Wrangler:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with local values.
npm run dev
```

In another terminal, call Wrangler's local scheduled endpoint:

```bash
curl "http://localhost:8787/__scheduled?cron=%2A%2F20%20%2A%20%2A%20%2A%20%2A"
```

Local Wrangler uses a local KV store, so this does not inspect or update production state unless you deliberately configure remote resources.

For an authenticated production run endpoint, create a long random token and save it as a secret:

```bash
openssl rand -hex 32
npx wrangler secret put TRIGGER_TOKEN
npx wrangler deploy
```

Then call the deployed Worker with that value:

```bash
curl -X POST \
  -H "Authorization: Bearer REPLACE_WITH_TRIGGER_TOKEN" \
  "https://simple-seeker-review-watcher.YOUR_SUBDOMAIN.workers.dev/run"
```

When `TRIGGER_TOKEN` is unset, `POST /run` returns 404. With a configured token, a missing or incorrect bearer token returns 401.

## Change the poll interval

Edit the cron expression in `wrangler.jsonc`, then redeploy:

```jsonc
"triggers": {
  "crons": ["*/20 * * * *"]
}
```

```bash
npx wrangler deploy
```

The publisher portal rate limit is roughly 30 requests per 10 minutes. Each ordinary run uses four portal requests when auto-discovery is active, or three when `DAPP_ID` is configured, plus at most one Telegram request. This stays within six subrequests in an ordinary run. The retry path makes exactly one extra sign-in and one poll attempt when portal access fails. Do not shorten the interval aggressively. If the cadence ever becomes much shorter, replace KV with a Durable Object to avoid races from KV's eventual consistency.

## What it detects

Each run fetches the newest three pages, up to 30 reviews, sorted newest first. It reports:

- `NEW` for a review id not previously seen
- `EDIT` when a rating or review text changes
- `REPLY ADDED`, `REPLY CHANGED`, or `REPLY REMOVED`
- Summary drift when the total changes in a way not explained by new reviews in the 30-review window
- Reply-count drift when the reply count changes without a visible reply event

Alerts contain at most 10 event lines, followed by the number omitted. State keeps older seen review ids so a review moving out of and later back into the window is not reported as new.

If a poll fails, the Worker uses email and password to mint one fresh JWT and retries once. It never loops on sign-in because the portal returns the same HTTP 200 `Left` envelope for bad credentials and rate limiting. After an unrecoverable failure, it sends one portal-unreachable alert and writes an independent `auth_broken` latch, even if the initial state has not been seeded yet. Repeated failures stay quiet. The next success clears the latch and sends one recovery alert. If that recovery is the first successful run, the review snapshot is still seeded without a review-change alert.

## Troubleshooting

### signIn returned Left

A `Left` response does not prove the password is wrong. The portal also uses it for rate limiting. Confirm `PORTAL_EMAIL` and `PORTAL_PASSWORD`, then wait at least 10 minutes before trying again. Watch `npx wrangler tail` for the procedure and error category. The Worker makes only one fresh login attempt per recovery cycle, so it will not create a login storm.

### No dApps found

Confirm that the login belongs to the publisher account that owns the dApp. If the portal lists it but auto-discovery does not, set its id explicitly as `DAPP_ID` in `wrangler.jsonc` and redeploy.

### Multiple dApps found

Run `npx wrangler tail`, wait for a poll, and copy the intended id from the logged `name=id` list into `DAPP_ID`. Redeploy after changing the variable.

### Telegram returns HTTP 400

The bot token was accepted, but the request data was not. The usual cause is a wrong chat id or a bot that has not been added to the target group. Ask @getmyid_bot for the id again and make sure a group id keeps its leading minus sign.

### Telegram returns HTTP 401

The bot token is invalid or has been revoked. Ask @BotFather for the current token and update it:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

### KV binding is missing

An error mentioning `REVIEW_WATCH` usually means the namespace was not created, its id was not pasted into `wrangler.jsonc`, or the binding name was changed. The binding must be named exactly `REVIEW_WATCH`. Create it, update the id, and deploy again.

### I got an alert storm

Check that every deploy points to the same production KV namespace. Replacing the namespace, deleting the `state` key, or switching environments loses change history. A completely missing or unreadable state normally seeds silently, but a partially replaced state can make reviews look new. Stop forced runs, restore the intended KV binding, allow one run to settle, and inspect logs before triggering again. At the default 20-minute cadence, KV eventual consistency can at worst repeat a recent alert briefly; persistent repeats indicate a binding or state problem.

## Cost and limits

The cron expression runs 3 times per hour:

```text
3 runs/hour × 24 hours/day = 72 Worker invocations/day
72 / 100,000 free requests/day = 0.072% of the daily request allowance
```

An ordinary auto-discovered poll uses `listDapps` plus three review pages and, only when needed, one Telegram call. That is no more than five external subrequests. KV stores three small values named `state`, `jwt`, and `auth_broken`. This workload is comfortably inside the Workers and KV free tiers. Cloudflare can change its limits, so check its current pricing page if you substantially change the schedule.

## Trust model

This is not a hosted service. There are no project accounts, telemetry, analytics, third-party scripts, or operator-controlled servers. The code runs in your Cloudflare account. Your portal password, Telegram bot token, optional portal JWT, and trigger token live in Cloudflare's secret store. Review state, the cached bearer token, and the portal-outage latch live in your KV namespace. The public status route exposes only information already public in the dApp Store and never echoes configuration or tokens.

Use this only with your own publisher account. Review the source and Cloudflare's secret-storage terms before deploying credentials.

## Development

Unit tests use Vitest with standard mocked `fetch`; no Cloudflare login, Miniflare, or Workers test pool is required:

```bash
npm install
npm run typecheck
npm test
```

CI runs install, typecheck, and tests on pushes and pull requests. There is intentionally no deploy workflow because it would require a Cloudflare API token in GitHub secrets. If you want continuous deployment, add a separate workflow that runs `npm ci` and `npm run deploy`, and configure `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID` as repository secrets.

A Docker/Python variant of the same idea also exists if you prefer to run the watcher on your own machine or server.

## License

MIT
