import dotenv from 'dotenv';
import express from 'express';

import { createCaptchaBrowser } from './captchaBrowser';
import { formatAllowedHosts, loadConfig, normalizeHost } from './config';
import { createOperatorService } from './operator';
import type { ChallengeState, FinishPayload, LogDetails } from './types';
import { errorMessage } from './types';

dotenv.config({ quiet: true });
const config = loadConfig();
process.env.DISPLAY = config.display;

const challenges = new Map<string, ChallengeState>();
const solveApp = express();
solveApp.use(express.json({ limit: '1mb' }));

function logChallenge(challengeId: string, message: string, details: LogDetails = {}): void {
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[challenge:${challengeId}] ${message}${suffix}`);
}

function normalizeChallengeId(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  return trimmed || undefined;
}

function asBodyRecord(body: unknown): Record<string, unknown> {
  return body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function validateSubmittedUrl(value: unknown, fieldName: string, allowedHosts: Set<string>): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  let parsed: URL;
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

function buildChallenge(body: unknown): ChallengeState {
  const record = asBodyRecord(body);
  const challengeId = normalizeChallengeId(record.challengeId);
  if (!challengeId || record.captchaUrl == null || record.callbackUrl == null) {
    throw new Error('challengeId, captchaUrl and callbackUrl are required');
  }

  return {
    challengeId,
    captchaUrl: validateSubmittedUrl(record.captchaUrl, 'captchaUrl', config.captchaAllowedHosts),
    callbackUrl: validateSubmittedUrl(record.callbackUrl, 'callbackUrl', config.callbackAllowedHosts),
    createdAt: new Date(),
    status: 'queued',
    tokenWaiters: new Set()
  };
}

function waitForToken(state: ChallengeState, timeoutMs: number): Promise<string> {
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

    const onToken = (token: string) => {
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
  performRelativePointerAction: captchaBrowser.performRelativePointerAction
});

async function postCallback(callbackUrl: string, body: Record<string, unknown>): Promise<void> {
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

async function finishChallenge(state: ChallengeState, payload: FinishPayload): Promise<void> {
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
    logChallenge(state.challengeId, 'callback delivery failed', { error: errorMessage(error) });
  } finally {
    await state.page?.close().catch(() => undefined);
    await state.context?.close().catch(() => undefined);
    challenges.delete(state.challengeId);
  }
}

async function runChallenge(state: ChallengeState): Promise<void> {
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
    logChallenge(state.challengeId, 'autosolve did not complete', { error: errorMessage(autosolveError) });

    try {
      const token = await operatorService.waitForOperator(state, autosolveError);
      logChallenge(state.challengeId, 'operator solve succeeded');
      await finishChallenge(state, { status: 'ok', token });
    } catch (operatorError) {
      logChallenge(state.challengeId, 'operator solve failed', { error: errorMessage(operatorError) });
      await finishChallenge(state, { status: 'failed', error: errorMessage(operatorError) });
    }
  }
}

solveApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, challenges: challenges.size });
});

solveApp.post('/solve', (req, res) => {
  let state: ChallengeState;
  try {
    state = buildChallenge(req.body || {});
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
    return;
  }

  if (challenges.has(state.challengeId)) {
    res.status(409).json({ error: 'challengeId is already running' });
    return;
  }

  challenges.set(state.challengeId, state);
  runChallenge(state).catch(async (error) => {
    logChallenge(state.challengeId, 'challenge failed outside solve flow', { error: errorMessage(error) });
    await finishChallenge(state, { status: 'failed', error: errorMessage(error) }).catch(() => undefined);
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
