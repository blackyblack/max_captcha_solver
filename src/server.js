'use strict';

require('dotenv').config({ quiet: true });

const express = require('express');
const { createCaptchaBrowser } = require('./captchaBrowser');
const { loadConfig, formatAllowedHosts, normalizeHost } = require('./config');
const { createOperatorService } = require('./operator');

const config = loadConfig();
process.env.DISPLAY = config.display;

const challenges = new Map();
const solveApp = express();
solveApp.use(express.json({ limit: '1mb' }));

function logChallenge(challengeId, message, details = {}) {
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[challenge:${challengeId}] ${message}${suffix}`);
}

function normalizeChallengeId(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  return trimmed || undefined;
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

  const submittedHost = normalizeHost(parsed.hostname);
  if (!allowedHosts.has(submittedHost)) {
    throw new Error(
      `${fieldName} host "${submittedHost}" is not allowed; allowed hosts: ${formatAllowedHosts(allowedHosts)}`
    );
  }

  return parsed.toString();
}

function buildChallenge(body) {
  const challengeId = normalizeChallengeId(body.challengeId);
  if (!challengeId || body.captchaUrl == null || body.callbackUrl == null) {
    throw new Error('challengeId, captchaUrl and callbackUrl are required');
  }

  return {
    challengeId,
    captchaUrl: validateSubmittedUrl(body.captchaUrl, 'captchaUrl', config.captchaAllowedHosts),
    callbackUrl: validateSubmittedUrl(body.callbackUrl, 'callbackUrl', config.callbackAllowedHosts),
    createdAt: new Date(),
    status: 'queued',
    tokenWaiters: new Set()
  };
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

const captchaBrowser = createCaptchaBrowser({
  config,
  log: logChallenge,
  waitForToken
});

const operatorService = createOperatorService({
  config,
  challenges,
  log: logChallenge,
  waitForToken,
  updateScreenshot: captchaBrowser.updateScreenshot,
  clickAtRelativePosition: captchaBrowser.clickAtRelativePosition
});

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

async function runChallenge(state) {
  logChallenge(state.challengeId, 'challenge accepted', {
    captchaUrl: state.captchaUrl,
    callbackUrl: state.callbackUrl
  });

  await captchaBrowser.openChallengePage(state);

  try {
    const token = await captchaBrowser.tryAutosolve(state);
    logChallenge(state.challengeId, 'autosolve succeeded');
    await finishChallenge(state, { status: 'ok', token });
  } catch (autosolveError) {
    logChallenge(state.challengeId, 'autosolve did not complete', { error: autosolveError.message });

    try {
      const token = await operatorService.waitForOperator(state, autosolveError);
      logChallenge(state.challengeId, 'operator solve succeeded');
      await finishChallenge(state, { status: 'ok', token });
    } catch (operatorError) {
      logChallenge(state.challengeId, 'operator solve failed', { error: operatorError.message });
      await finishChallenge(state, { status: 'failed', error: operatorError.message });
    }
  }
}

solveApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, challenges: challenges.size });
});

solveApp.post('/solve', (req, res) => {
  let state;
  try {
    state = buildChallenge(req.body || {});
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  if (challenges.has(state.challengeId)) {
    res.status(409).json({ error: 'challengeId is already running' });
    return;
  }

  challenges.set(state.challengeId, state);
  runChallenge(state).catch(async (error) => {
    logChallenge(state.challengeId, 'challenge failed outside solve flow', { error: error.message });
    await finishChallenge(state, { status: 'failed', error: error.message }).catch(() => undefined);
  });

  res.status(202).json({
    challengeId: state.challengeId,
    status: 'accepted',
    operatorUrl: operatorService.getOperatorUrl(state.challengeId)
  });
});

process.on('SIGTERM', async () => {
  await captchaBrowser.closeBrowser();
  process.exit(0);
});

solveApp.listen(config.solvePort, config.solveHost, () => {
  console.log(`captcha solve API listening on ${config.solveHost}:${config.solvePort}`);
});

operatorService.app.listen(config.operatorPort, config.operatorHost, () => {
  console.log(`captcha operator API listening on ${config.operatorHost}:${config.operatorPort}`);
});
