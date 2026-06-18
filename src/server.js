'use strict';

const express = require('express');
const { chromium } = require('playwright');

const config = {
  port: Number(process.env.PORT || 3000),
  autosolveDelayMs: Number(process.env.AUTOSOLVE_DELAY_MS || 3000),
  autosolveTimeoutMs: Number(process.env.AUTOSOLVE_TIMEOUT_MS || 15000),
  operatorTimeoutMs: Number(process.env.OPERATOR_TIMEOUT_MS || 180000),
  operatorViewBaseUrl: process.env.OPERATOR_VIEW_BASE_URL || '',
  userAgent:
    process.env.BROWSER_UA ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  display: process.env.DISPLAY || ':99',
  browserChannel: process.env.BROWSER_CHANNEL || '',
  viewportWidth: Number(process.env.VIEWPORT_WIDTH || 1280),
  viewportHeight: Number(process.env.VIEWPORT_HEIGHT || 800),
  screenshotIntervalMs: Number(process.env.OPERATOR_SCREENSHOT_INTERVAL_MS || 1000)
};

process.env.DISPLAY = config.display;

const app = express();
app.use(express.json({ limit: '1mb' }));

const challenges = new Map();
let browserPromise;

function logChallenge(challengeId, message, details = {}) {
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[challenge:${challengeId}] ${message}${suffix}`);
}

function summarizeCaptchaUrl(captchaUrl) {
  try {
    const url = new URL(captchaUrl);
    return {
      origin: url.origin,
      path: url.pathname,
      domain: url.searchParams.get('domain'),
      variant: url.searchParams.get('variant'),
      blank: url.searchParams.get('blank'),
      hasSessionToken: url.searchParams.has('session_token')
    };
  } catch (error) {
    return { invalid: true, error: error.message };
  }
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: false,
      ...(config.browserChannel ? { channel: config.browserChannel } : {}),
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--window-size=${config.viewportWidth},${config.viewportHeight}`
      ]
    });
  }
  return browserPromise;
}

function publicChallengeUrl(challengeId) {
  const path = `/operator/${encodeURIComponent(challengeId)}`;
  return config.operatorViewBaseUrl ? `${config.operatorViewBaseUrl.replace(/\/$/, '')}${path}` : path;
}

function operatorFollowUrl(challengeId) {
  const path = `/operator/${encodeURIComponent(challengeId)}`;
  const baseUrl = config.operatorViewBaseUrl || `http://127.0.0.1:${config.port}`;
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function postCallback(callbackUrl, body) {
  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`callback returned ${response.status}: ${text.slice(0, 500)}`);
  }
}

function extractSuccessToken(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  return (
    payload.success_token ||
    payload.successToken ||
    payload.response?.success_token ||
    payload.response?.successToken ||
    payload.result?.success_token ||
    payload.result?.successToken
  );
}

function waitForToken(state, timeoutMs) {
  if (state.token) return Promise.resolve(state.token);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for success_token after ${timeoutMs} ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      state.tokenWaiters.delete(onToken);
    };

    const onToken = (token) => {
      cleanup();
      resolve(token);
    };

    state.tokenWaiters.add(onToken);
  });
}

function captureTokenFromResponse(state, response) {
  const url = response.url();
  if (!url.includes('/method/captchaNotRobot.check')) return;

  logChallenge(state.challengeId, 'captcha check response received', {
    status: response.status()
  });

  response
    .json()
    .then((payload) => {
      const token = extractSuccessToken(payload);
      logChallenge(state.challengeId, 'captcha check response parsed', {
        tokenAvailable: Boolean(token),
        alreadyCaptured: Boolean(state.token)
      });
      if (!token || state.token) return;
      state.token = token;
      logChallenge(state.challengeId, 'success token captured');
      for (const waiter of state.tokenWaiters) waiter(token);
    })
    .catch((error) => {
      logChallenge(state.challengeId, 'captcha check response parse failed', { error: error.message });
    });
}

async function clickCheckbox(state) {
  const { page, challengeId } = state;
  const checkbox = page.locator('#not-robot-captcha-checkbox').first();
  if (await checkbox.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await checkbox.boundingBox().catch(() => undefined);
    logChallenge(challengeId, 'autoclick target found', {
      strategy: 'checkbox-selector',
      box
    });
    if (box) {
      const x = Math.round(box.x + Math.min(22, box.width / 2));
      const y = Math.round(box.y + box.height / 2);
      logChallenge(challengeId, 'autoclick using detected checkbox coordinates', { strategy: 'checkbox-selector', x, y });
      await page.mouse.click(x, y, { delay: 120 });
    } else {
      await checkbox.click({ delay: 120, timeout: 3000, force: true });
    }
    logChallenge(challengeId, 'autoclick completed', { strategy: 'checkbox-selector' });
    return 'checkbox-selector';
  }
  logChallenge(challengeId, 'autoclick checkbox selector not visible');

  const label = page.getByText(/я не робот|i'?m not a robot|i am not a robot/i).first();
  if (await label.isVisible({ timeout: 1000 }).catch(() => false)) {
    const box = await label.boundingBox().catch(() => undefined);
    logChallenge(challengeId, 'autoclick target found', {
      strategy: 'label-text',
      box
    });
    if (box) {
      const x = Math.round(box.x + Math.min(22, box.width / 2));
      const y = Math.round(box.y + box.height / 2);
      logChallenge(challengeId, 'autoclick using detected label coordinates', { strategy: 'label-text', x, y });
      await page.mouse.click(x, y, { delay: 120 });
    } else {
      await label.click({ delay: 120, timeout: 3000, force: true });
    }
    logChallenge(challengeId, 'autoclick completed', { strategy: 'label-text' });
    return 'label-text';
  }
  logChallenge(challengeId, 'autoclick label text not visible');

  const viewport = page.viewportSize() || { width: config.viewportWidth, height: config.viewportHeight };
  const x = Math.round(viewport.width / 2 - 55);
  const y = Math.round(viewport.height / 2 + 80);
  logChallenge(challengeId, 'autoclick using fallback coordinate', {
    strategy: 'fallback-coordinate',
    viewport,
    x,
    y
  });
  await page.mouse.click(x, y, { delay: 120 });
  logChallenge(challengeId, 'autoclick completed', { strategy: 'fallback-coordinate' });
  return 'fallback-coordinate';
}

async function updateScreenshot(state) {
  if (!state.page || state.done) return;
  try {
    state.screenshot = await state.page.screenshot({ type: 'jpeg', quality: 70 });
    state.lastScreenshotAt = new Date();
  } catch (error) {
    state.lastScreenshotError = error.message;
  }
}

function startOperatorScreenshots(state) {
  updateScreenshot(state);
  state.screenshotTimer = setInterval(() => updateScreenshot(state), config.screenshotIntervalMs);
}

async function finishChallenge(state, payload) {
  if (state.done) return;
  state.done = true;
  if (state.screenshotTimer) clearInterval(state.screenshotTimer);

  logChallenge(state.challengeId, 'finishing challenge', {
    status: payload.status,
    tokenAvailable: Boolean(payload.token),
    error: payload.error
  });

  try {
    await postCallback(state.callbackUrl, { challengeId: state.challengeId, ...payload });
    logChallenge(state.challengeId, 'callback posted', { status: payload.status });
  } finally {
    await state.page?.close().catch(() => undefined);
    challenges.delete(state.challengeId);
  }
}

async function solveChallenge({ challengeId, captchaUrl, callbackUrl }) {
  logChallenge(challengeId, 'challenge accepted', {
    captchaUrl: summarizeCaptchaUrl(captchaUrl),
    autosolveDelayMs: config.autosolveDelayMs,
    autosolveTimeoutMs: config.autosolveTimeoutMs,
    operatorTimeoutMs: config.operatorTimeoutMs
  });

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow'
  });
  const page = await context.newPage();
  const state = {
    challengeId,
    captchaUrl,
    callbackUrl,
    page,
    context,
    createdAt: new Date(),
    status: 'running',
    tokenWaiters: new Set()
  };

  challenges.set(challengeId, state);
  page.on('response', (response) => captureTokenFromResponse(state, response));

  try {
    logChallenge(challengeId, 'navigating to captcha');
    const navigationResponse = await page.goto(captchaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    logChallenge(challengeId, 'captcha navigation completed', {
      status: navigationResponse?.status(),
      finalUrl: summarizeCaptchaUrl(page.url())
    });
    logChallenge(challengeId, 'waiting before autoclick', { delayMs: config.autosolveDelayMs });
    await page.waitForTimeout(config.autosolveDelayMs);
    const autoclickStrategy = await clickCheckbox(state);
    logChallenge(challengeId, 'waiting for success token after autoclick', {
      strategy: autoclickStrategy,
      timeoutMs: config.autosolveTimeoutMs
    });
    const token = await waitForToken(state, config.autosolveTimeoutMs);
    logChallenge(challengeId, 'autosolve succeeded');
    await finishChallenge(state, { status: 'ok', token });
  } catch (autosolveError) {
    logChallenge(challengeId, 'autosolve did not complete', { error: autosolveError.message });
    if (state.token) {
      logChallenge(challengeId, 'token was captured during autosolve error handling');
      await finishChallenge(state, { status: 'ok', token: state.token });
      return;
    }

    state.status = 'operator_required';
    state.operatorUrl = publicChallengeUrl(challengeId);
    state.autosolveError = autosolveError.message;
    logChallenge(challengeId, 'operator interaction required', {
      operatorUrl: operatorFollowUrl(challengeId),
      reason: autosolveError.message,
      timeoutMs: config.operatorTimeoutMs
    });
    startOperatorScreenshots(state);

    try {
      logChallenge(challengeId, 'waiting for success token from operator');
      const token = await waitForToken(state, config.operatorTimeoutMs);
      logChallenge(challengeId, 'operator solve succeeded');
      await finishChallenge(state, { status: 'ok', token });
    } catch (operatorError) {
      logChallenge(challengeId, 'operator solve failed', { error: operatorError.message });
      await finishChallenge(state, { status: 'failed', error: operatorError.message });
    }
  } finally {
    if (state.done) await context.close().catch(() => undefined);
  }
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, challenges: challenges.size });
});

app.post('/solve', (req, res) => {
  const { challengeId, captchaUrl, callbackUrl } = req.body || {};
  if (!challengeId || !captchaUrl || !callbackUrl) {
    res.status(400).json({ error: 'challengeId, captchaUrl and callbackUrl are required' });
    return;
  }
  if (challenges.has(challengeId)) {
    res.status(409).json({ error: 'challengeId is already running' });
    return;
  }

  solveChallenge({ challengeId, captchaUrl, callbackUrl }).catch(async (error) => {
    logChallenge(challengeId, 'challenge failed outside solve flow', { error: error.message });
    const state = challenges.get(challengeId);
    if (state) {
      await finishChallenge(state, { status: 'failed', error: error.message }).catch(() => undefined);
      await state.context?.close().catch(() => undefined);
    } else {
      await postCallback(callbackUrl, { challengeId, status: 'failed', error: error.message }).catch(() => undefined);
    }
  });

  res.status(202).json({ challengeId, status: 'accepted', operatorUrl: publicChallengeUrl(challengeId) });
});

app.get('/operator/:challengeId', (req, res) => {
  const state = challenges.get(req.params.challengeId);
  if (!state) {
    res.status(404).send('challenge not found');
    return;
  }

  logChallenge(state.challengeId, 'operator view opened');

  res.type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Captcha ${state.challengeId}</title>
<style>body{margin:0;background:#111;color:#eee;font-family:sans-serif}#bar{padding:8px}#screen{width:100%;touch-action:none;display:block}</style></head>
<body><div id="bar">${state.challengeId}: <span id="status">${state.status}</span></div><img id="screen" src="/operator/${encodeURIComponent(state.challengeId)}/screenshot">
<script>
const id=${JSON.stringify(state.challengeId)}; const img=document.getElementById('screen');
setInterval(()=>{ img.src='/operator/'+encodeURIComponent(id)+'/screenshot?t='+Date.now(); }, ${Math.max(500, config.screenshotIntervalMs)});
img.addEventListener('click', async (event)=>{
  const rect=img.getBoundingClientRect();
  await fetch('/operator/'+encodeURIComponent(id)+'/tap',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height})});
});
</script></body></html>`);
});

app.get('/operator/:challengeId/screenshot', async (req, res) => {
  const state = challenges.get(req.params.challengeId);
  if (!state) {
    res.status(404).end();
    return;
  }
  if (!state.screenshot) await updateScreenshot(state);
  res.type('jpg').send(state.screenshot || Buffer.alloc(0));
});

app.post('/operator/:challengeId/tap', async (req, res) => {
  const state = challenges.get(req.params.challengeId);
  if (!state) {
    res.status(404).json({ error: 'challenge not found' });
    return;
  }
  const viewport = state.page.viewportSize() || { width: config.viewportWidth, height: config.viewportHeight };
  const x = Math.max(0, Math.min(1, Number(req.body.x))) * viewport.width;
  const y = Math.max(0, Math.min(1, Number(req.body.y))) * viewport.height;
  logChallenge(state.challengeId, 'operator tap received', {
    normalizedX: req.body.x,
    normalizedY: req.body.y,
    x,
    y,
    viewport
  });
  await state.page.mouse.click(x, y, { delay: 80 });
  res.json({ ok: true });
});

process.on('SIGTERM', async () => {
  const browser = await browserPromise?.catch(() => undefined);
  await browser?.close().catch(() => undefined);
  process.exit(0);
});

app.listen(config.port, () => {
  console.log(`captcha solver listening on :${config.port}`);
});
