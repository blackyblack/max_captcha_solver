# MAX captcha solver

Standalone service that drives a real, non-headless Chromium with Playwright to solve VK ID `not_robot_captcha` challenges for `web.max.ru`.

## API

`POST /solve`

```json
{ "challengeId": "id-1", "captchaUrl": "https://id.vk.ru/not_robot_captcha?...", "callbackUrl": "https://example.com/callback" }
```

Returns `202 Accepted` immediately. The captcha URL must be freshly fetched immediately before this call because VK session tokens are short-lived and single-use.

The service later posts one of these payloads to `callbackUrl`:

```json
{ "challengeId": "id-1", "status": "ok", "token": "success_token" }
```

```json
{ "challengeId": "id-1", "status": "failed", "error": "reason" }
```

## How it works

For every challenge the service opens a fresh page in a reused non-headless Chromium instance, registers a Playwright response listener for `/method/captchaNotRobot.check`, and extracts `success_token` from the JSON response. It then navigates to the provided captcha URL, waits `AUTOSOLVE_DELAY_MS`, clicks the visible checkbox or a fallback coordinate near the popup checkbox, and waits `AUTOSOLVE_TIMEOUT_MS` for a token.

If autosolve times out, a lightweight operator view is available at `/operator/:challengeId`. It streams screenshots and relays phone taps to `page.mouse.click`; the same response listener captures the token after the operator solves the challenge.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `AUTOSOLVE_DELAY_MS` | `3000` | Delay before clicking the checkbox. |
| `AUTOSOLVE_TIMEOUT_MS` | `15000` | Time to wait for `success_token` after autosolve click. |
| `OPERATOR_TIMEOUT_MS` | `180000` | Time to keep the operator page alive before failing. |
| `OPERATOR_VIEW_BASE_URL` | empty | Public base URL used in the accepted response. |
| `BROWSER_UA` | Chrome Linux UA | Browser user agent. |
| `DISPLAY` | `:99` | Xvfb display used by Chromium. |
| `BROWSER_CHANNEL` | empty | Optional Playwright browser channel, for example `chrome` when Google Chrome is installed. |
| `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT` | `1280` / `800` | Browser viewport. |

## Run

```sh
npm install
npm start
```

## Manual live check

Use `.tmp/live-check.js` to test a freshly generated captcha URL end to end. The script starts the solver on `127.0.0.1:3217`, starts a local callback receiver on `127.0.0.1:3218`, submits `POST /solve`, and prints whether the callback contains a token.

The captcha URL must be fresh and unused. Expired or already-used `session_token` values may still return HTTP 200 but render a blank page or never produce `success_token`.

PowerShell:

```powershell
$env:CAPTCHA_URL='https://id.vk.ru/not_robot_captcha?...'
node .tmp\live-check.js
```

Expected success shape:

```text
accepted_status=202
accepted_body={"challengeId":"live-...","status":"accepted","operatorUrl":"http://127.0.0.1:3217/operator/live-..."}
callback_payload={"challengeId":"live-...","status":"ok","token":"..."}
token_available=true
```

If `token_available=false`, check `callback_payload.error`. A timeout usually means the page did not expose the captcha, the token expired, or manual operator solving was not completed before `OPERATOR_TIMEOUT_MS`.

The harness forces `BROWSER_CHANNEL=chrome`, so install Google Chrome or change `.tmp/live-check.js` to another Playwright channel such as `msedge`.

## Docker

```sh
docker build -t max-captcha-solver .
docker run --rm -p 3000:3000 max-captcha-solver
```
