# MAX captcha solver

Standalone service that solves VK ID `not_robot_captcha` challenges for MAX auth flows and returns the resulting session token through a callback.

## Run

```sh
npm install
cp .env.template .env
npm start
```

## API

The service exposes two HTTP listeners:

- Solve API: `SOLVE_HOST:SOLVE_PORT`, defaults to `127.0.0.1:3000`. This listener is intended for local callers only and is not authenticated.
- Operator API: `OPERATOR_HOST:OPERATOR_PORT`, defaults to `0.0.0.0:3001`. Operator routes require an active `challengeId` in the URL and are short lived.

### `POST /solve`

Starts a challenge on the solve API. `captchaUrl` must be fresh and unused.

```json
{
  "challengeId": "id-1",
  "captchaUrl": "https://id.vk.ru/not_robot_captcha?...",
  "callbackUrl": "https://max-login.example/captcha-callback"
}
```

Returns `202 Accepted` immediately:

```json
{
  "challengeId": "id-1",
  "status": "accepted",
  "operatorUrl": "https://solver.example/operator/id-1"
}
```

When solved, the service posts to `callbackUrl`:

```json
{
  "challengeId": "id-1",
  "status": "ok",
  "token": "success_token"
}
```

On failure:

```json
{
  "challengeId": "id-1",
  "status": "failed",
  "error": "reason"
}
```

### `GET /healthz`

Both listeners expose this endpoint and return service health with the active challenge count:

```json
{
  "ok": true,
  "challenges": 0
}
```

## Operator Handoff

The service first tries to solve automatically. If autosolve times out, it exposes `/operator/:challengeId` for manual solving and sends an operator notification.

Telegram notifications are sent when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured.

## Telegram Setup

1. Open Telegram and start a chat with `@BotFather`.
2. Send `/newbot`, choose a name and username, and copy the bot token into `TELEGRAM_BOT_TOKEN`.
3. Start a direct chat with the new bot, or add it to the operator group.
4. Send any message to the bot or group.
5. Open `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates` in a browser.
6. Copy the `chat.id` value into `TELEGRAM_CHAT_ID`. Group chat IDs are usually negative numbers.

After changing `.env`, restart the service.

## Configuration

Copy `.env.template` to `.env` and adjust values there. The service loads `.env` with `dotenv` on startup.

`OPERATOR_VIEW_BASE_URL` should point at the public operator listener, for example `https://solver.example`, when operators open links from outside the host.

`CAPTCHA_ALLOWED_HOSTS` and `CALLBACK_ALLOWED_HOSTS` are comma-separated host allowlists for submitted `captchaUrl` and `callbackUrl` values. The defaults are `id.vk.ru` for captcha URLs and `127.0.0.1,localhost,::1` for callback URLs. Submitted URLs must use `http` or `https` and must not include credentials.

`CALLBACK_TIMEOUT_MS` limits callback delivery time. Callback failures and timeouts are logged, but the browser page, context, and challenge entry are still cleaned up.

## Docker

```sh
docker build -t max-captcha-solver .
docker run --rm -p 3001:3001 max-captcha-solver
```

To access the solve API from the Docker host while keeping it host-local, publish it only on host loopback:

```sh
docker run --rm -p 127.0.0.1:3000:3000 -p 3001:3001 -e SOLVE_HOST=0.0.0.0 max-captcha-solver
```
