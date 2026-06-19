'use strict';

require('dotenv').config({ quiet: true });

const express = require('express');
const { chromium } = require('playwright');
const { notifyManualSolveRequired } = require('./notifications');

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

function parseAllowedHosts(value, fallback) {
  return new Set(
    String(value || fallback)
      .split(',')
      .map((host) => normalizeHost(host))
      .filter(Boolean)
  );
}

const config = {
  solvePort: Number(process.env.SOLVE_PORT || process.env.PORT || 3000),
  solveHost: process.env.SOLVE_HOST || '127.0.0.1',
  operatorPort: Number(process.env.OPERATOR_PORT || 3001),
  operatorHost: process.env.OPERATOR_HOST || '0.0.0.0',
  autosolveDelayMs: Number(process.env.AUTOSOLVE_DELAY_MS || 3000),
  autosolveTimeoutMs: Number(process.env.AUTOSOLVE_TIMEOUT_MS || 15000),
  operatorTimeoutMs: Number(process.env.OPERATOR_TIMEOUT_MS || 180000),
  operatorViewBaseUrl: process.env.OPERATOR_VIEW_BASE_URL || '',
  callbackTimeoutMs: Number(process.env.CALLBACK_TIMEOUT_MS || 10000),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramNotifyTimeoutMs: Number(process.env.TELEGRAM_NOTIFY_TIMEOUT_MS || 5000),
  userAgent:
    process.env.BROWSER_UA ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  display: process.env.DISPLAY || ':99',
  browserChannel: process.env.BROWSER_CHANNEL || '',
  viewportWidth: Number(process.env.VIEWPORT_WIDTH || 1280),
  viewportHeight: Number(process.env.VIEWPORT_HEIGHT || 800),
  screenshotIntervalMs: Number(process.env.OPERATOR_SCREENSHOT_INTERVAL_MS || 1000),
  captchaAllowedHosts: parseAllowedHosts(process.env.CAPTCHA_ALLOWED_HOSTS, 'id.vk.ru'),
  callbackAllowedHosts: parseAllowedHosts(process.env.CALLBACK_ALLOWED_HOSTS, '127.0.0.1,localhost,::1')
};

process.env.DISPLAY = config.display;

const solveApp = express();
const operatorApp = express();
solveApp.use(express.json({ limit: '1mb' }));
operatorApp.use(express.json({ limit: '1mb' }));

const challenges = new Map();
let browserPromise;

function logChallenge(challengeId, message, details = {}) {
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[challenge:${challengeId}] ${message}${suffix}`);
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: false,
        ...(config.browserChannel ? { channel: config.browserChannel } : {}),
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          `--window-size=${config.viewportWidth},${config.viewportHeight}`
        ]
      })
      .catch((error) => {
        browserPromise = undefined;
        throw error;
      });
  }
  return browserPromise;
}

function normalizeChallengeId(value) {
  if (!['string', 'number'].includes(typeof value)) return undefined;
  const challengeId = String(value);
  return challengeId.trim() ? challengeId : undefined;
}

function validateSubmittedUrl(value, fieldName, allowedHosts) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid http(s) URL`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${fieldName} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${fieldName} must not include credentials`);
  }
  if (!allowedHosts.has(normalizeHost(parsed.hostname))) {
    throw new Error(`${fieldName} host is not allowed`);
  }

  return parsed.toString();
}

function operatorUrl(challengeId) {
  const path = `/operator/${encodeURIComponent(challengeId)}`;
  const baseUrl = config.operatorViewBaseUrl || `http://127.0.0.1:${config.operatorPort}`;
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function postCallback(callbackUrl, body) {
  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(config.callbackTimeoutMs),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`callback returned ${response.status}: ${text.slice(0, 500)}`);
  }
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return char;
    }
  });
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
      reject(new Error('timed out waiting for success_token'));
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

  logChallenge(state.challengeId, 'captcha check response received', { status: response.status() });

  response
    .json()
    .then((payload) => {
      const token = extractSuccessToken(payload);
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
    if (box) {
      const x = Math.round(box.x + Math.min(22, box.width / 2));
      const y = Math.round(box.y + box.height / 2);
      await page.mouse.click(x, y, { delay: 120 });
    } else {
      await checkbox.click({ delay: 120, timeout: 3000, force: true });
    }
    logChallenge(challengeId, 'autoclick completed', { strategy: 'checkbox-selector' });
    return 'checkbox-selector';
  }

  const label = page.getByText(/я не робот|i'?m not a robot|i am not a robot/i).first();
  if (await label.isVisible({ timeout: 1000 }).catch(() => false)) {
    const box = await label.boundingBox().catch(() => undefined);
    if (box) {
      const x = Math.round(box.x + Math.min(22, box.width / 2));
      const y = Math.round(box.y + box.height / 2);
      await page.mouse.click(x, y, { delay: 120 });
    } else {
      await label.click({ delay: 120, timeout: 3000, force: true });
    }
    logChallenge(challengeId, 'autoclick completed', { strategy: 'label-text' });
    return 'label-text';
  }

  const viewport = page.viewportSize() || { width: config.viewportWidth, height: config.viewportHeight };
  const x = Math.round(viewport.width / 2 - 55);
  const y = Math.round(viewport.height / 2 + 80);
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
  } catch (error) {
    logChallenge(state.challengeId, 'callback delivery failed', { error: error.message });
  } finally {
    await state.page?.close().catch(() => undefined);
    await state.context?.close().catch(() => undefined);
    challenges.delete(state.challengeId);
  }
}

async function solveChallenge(state) {
  const { challengeId, captchaUrl, callbackUrl } = state;
  logChallenge(challengeId, 'challenge accepted', {
    captchaUrl,
    callbackUrl
  });

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow'
  });
  state.context = context;
  const page = await context.newPage();
  state.page = page;
  state.status = 'running';
  page.on('response', (response) => captureTokenFromResponse(state, response));

  try {
    logChallenge(challengeId, 'navigating to captcha');
    const navigationResponse = await page.goto(captchaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    logChallenge(challengeId, 'captcha navigation completed', {
      status: navigationResponse?.status()
    });
    await page.waitForTimeout(config.autosolveDelayMs);
    const autoclickStrategy = await clickCheckbox(state);
    logChallenge(challengeId, 'waiting for success token after autoclick', {
      strategy: autoclickStrategy
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
    state.operatorUrl = operatorUrl(challengeId);
    state.autosolveError = autosolveError.message;
    logChallenge(challengeId, 'operator interaction required', {
      operatorUrl: state.operatorUrl,
      reason: autosolveError.message
    });
    startOperatorScreenshots(state);
    await notifyManualSolveRequired({
      challengeId,
      operatorUrl: state.operatorUrl,
      reason: autosolveError.message,
      config,
      log: logChallenge
    });

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

solveApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, challenges: challenges.size });
});

solveApp.post('/solve', (req, res) => {
  const body = req.body || {};
  const challengeId = normalizeChallengeId(body.challengeId);
  if (!challengeId || body.captchaUrl == null || body.callbackUrl == null) {
    res.status(400).json({ error: 'challengeId, captchaUrl and callbackUrl are required' });
    return;
  }

  let captchaUrl;
  let callbackUrl;
  try {
    captchaUrl = validateSubmittedUrl(body.captchaUrl, 'captchaUrl', config.captchaAllowedHosts);
    callbackUrl = validateSubmittedUrl(body.callbackUrl, 'callbackUrl', config.callbackAllowedHosts);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  if (challenges.has(challengeId)) {
    res.status(409).json({ error: 'challengeId is already running' });
    return;
  }

  const state = {
    challengeId,
    captchaUrl,
    callbackUrl,
    createdAt: new Date(),
    status: 'queued',
    tokenWaiters: new Set()
  };
  challenges.set(challengeId, state);

  solveChallenge(state).catch(async (error) => {
    logChallenge(challengeId, 'challenge failed outside solve flow', { error: error.message });
    await finishChallenge(state, { status: 'failed', error: error.message }).catch(() => undefined);
  });

  res.status(202).json({ challengeId, status: 'accepted', operatorUrl: operatorUrl(challengeId) });
});

operatorApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, challenges: challenges.size });
});

operatorApp.get('/operator/:challengeId', (req, res) => {
  const state = challenges.get(req.params.challengeId);
  if (!state) {
    res.status(404).send('challenge not found');
    return;
  }

  logChallenge(state.challengeId, 'operator view opened');

  const challengeId = jsonForInlineScript(state.challengeId);
  const status = jsonForInlineScript(state.status);
  const screenshotPath = jsonForInlineScript(`/operator/${encodeURIComponent(state.challengeId)}/screenshot`);

  res.type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title></title>
<style>body{margin:0;background:#111;color:#eee;font-family:sans-serif}#bar{padding:8px}#screen{width:100%;touch-action:none;display:block}</style></head>
<body><div id="bar"><span id="challenge"></span>: <span id="status"></span></div><img id="screen" alt="">
<script>
const id=${challengeId};
const status=${status};
const screenshotPath=${screenshotPath};
document.title='Captcha '+id;
document.getElementById('challenge').textContent=id;
document.getElementById('status').textContent=status;
const img=document.getElementById('screen');
img.src=screenshotPath;
setInterval(()=>{ img.src=screenshotPath+'?t='+Date.now(); }, ${Math.max(500, config.screenshotIntervalMs)});
img.addEventListener('click', async (event)=>{
  const rect=img.getBoundingClientRect();
  await fetch('/operator/'+encodeURIComponent(id)+'/tap',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height})});
});
</script></body></html>`);
});

operatorApp.get('/operator/:challengeId/screenshot', async (req, res) => {
  const state = challenges.get(req.params.challengeId);
  if (!state) {
    res.status(404).end();
    return;
  }
  if (!state.screenshot) await updateScreenshot(state);
  res.type('jpg').send(state.screenshot || Buffer.alloc(0));
});

operatorApp.post('/operator/:challengeId/tap', async (req, res) => {
  const state = challenges.get(req.params.challengeId);
  if (!state) {
    res.status(404).json({ error: 'challenge not found' });
    return;
  }
  if (!state.page) {
    res.status(409).json({ error: 'challenge is not ready for operator input' });
    return;
  }
  const relativeX = Number(req.body?.x);
  const relativeY = Number(req.body?.y);
  if (
    !Number.isFinite(relativeX) ||
    !Number.isFinite(relativeY) ||
    relativeX < 0 ||
    relativeX > 1 ||
    relativeY < 0 ||
    relativeY > 1
  ) {
    res.status(400).json({ error: 'x and y must be finite numbers between 0 and 1' });
    return;
  }
  const viewport = state.page.viewportSize() || { width: config.viewportWidth, height: config.viewportHeight };
  const x = relativeX * viewport.width;
  const y = relativeY * viewport.height;
  logChallenge(state.challengeId, 'operator tap received', {
    relativeX,
    relativeY,
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

solveApp.listen(config.solvePort, config.solveHost, () => {
  console.log(`captcha solve API listening on ${config.solveHost}:${config.solvePort}`);
});

operatorApp.listen(config.operatorPort, config.operatorHost, () => {
  console.log(`captcha operator API listening on ${config.operatorHost}:${config.operatorPort}`);
});
