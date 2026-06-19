# MAX captcha solver

Standalone service that solves VK ID `not_robot_captcha` challenges for MAX auth flows. It accepts a captcha URL, tries to click the challenge in Chromium, falls back to a short-lived operator page when needed, and posts the resulting `success_token` to a callback URL.

See [API.md](./API.md) for endpoint details.

## Prerequisites

- Node.js 18 or newer.
- A Chromium runtime supported by Playwright.
- On headless Linux or Docker, an X server such as Xvfb because Chromium runs with `headless: false`.
- Network access to the submitted captcha URL, callback URL, and Telegram API if notifications are enabled.

## Installation

```sh
npm install
cp .env.template .env
npm run build
```

`npm install` also downloads the Playwright Chromium runtime used by the service.
If npm lifecycle scripts are disabled, run `npm run install:browser` before starting the service.

## Run

```sh
npm start
```

`npm start` runs the compiled service from `dist/`. Re-run `npm run build` after changing files under `src/`.

Docker:

```sh
docker build -t max-captcha-solver .
docker run --rm -p 127.0.0.1:3000:3000 -p 3001:3001 max-captcha-solver
```

This publishes the solve API only on host loopback and exposes the operator API on port `3001`.

## Configuration

The service loads `.env` with `dotenv`. Empty values use the defaults below.

`SOLVE_PORT`
Default: `3000`.
Solve API port. If empty, `PORT` is used before this default.

`PORT`
Default: empty.
Compatibility fallback for `SOLVE_PORT`.

`SOLVE_HOST`
Default: `127.0.0.1`.
Solve API bind host. Keep this private; the solve API is not authenticated.

`OPERATOR_PORT`
Default: `3001`.
Operator API port.

`OPERATOR_HOST`
Default: `0.0.0.0`.
Operator API bind host.

`AUTOSOLVE_DELAY_MS`
Default: `3000`.
Delay after page load before the automatic click.

`AUTOSOLVE_TIMEOUT_MS`
Default: `15000`.
Time to wait for `success_token` after automatic click.

`OPERATOR_TIMEOUT_MS`
Default: `180000`.
Time to wait for manual operator solving.

`OPERATOR_VIEW_BASE_URL`
Default: empty.
Public base URL used in operator notification links. Defaults to `http://127.0.0.1:OPERATOR_PORT`.

`CAPTCHA_ALLOWED_HOSTS`
Default: `id.vk.ru`.
Comma-separated host allowlist for submitted captcha URLs.

`CALLBACK_ALLOWED_HOSTS`
Default: `127.0.0.1,localhost,::1,host.docker.internal`.
Comma-separated host allowlist for submitted callback URLs.

`CALLBACK_TIMEOUT_MS`
Default: `10000`.
Callback POST timeout. Callback failures are logged and cleanup still runs.

`TELEGRAM_BOT_TOKEN`
Default: empty.
Enables Telegram operator notifications when set with `TELEGRAM_CHAT_ID`.

`TELEGRAM_CHAT_ID`
Default: empty.
Telegram target chat ID.

`TELEGRAM_NOTIFY_TIMEOUT_MS`
Default: `5000`.
Telegram send timeout.

`BROWSER_UA`
Default: Chrome Linux UA.
Browser user agent.

`DISPLAY`
Default: `:99`.
Display used by Chromium and Xvfb.

`BROWSER_CHANNEL`
Default: empty.
Optional Playwright browser channel, for example `chrome`.

`VIEWPORT_WIDTH`
Default: `1280`.
Browser viewport width.

`VIEWPORT_HEIGHT`
Default: `800`.
Browser viewport height.

`OPERATOR_SCREENSHOT_INTERVAL_MS`
Default: `1000`.
Operator page screenshot refresh interval.

Submitted `captchaUrl` and `callbackUrl` values must use `http` or `https`, must not contain credentials, and must pass their host allowlists.

When the callback receiver runs on the Docker host, submit `callbackUrl` as `http://host.docker.internal:<port>/...`; inside the container, `127.0.0.1` points back to the solver container.

## Telegram Hints

1. Create a bot with `@BotFather` and put its token in `TELEGRAM_BOT_TOKEN`.
2. Start a direct chat with the bot, or add it to an operator group.
3. Send any message to the bot or group.
4. Open `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates`.
5. Put the `chat.id` value in `TELEGRAM_CHAT_ID`.

Restart the service after changing `.env`.
