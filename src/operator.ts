import express from 'express';

import { notifyManualSolveRequired } from './notifications';
import { renderOperatorView } from './operatorView';
import type { ChallengeLog, ChallengeState, RelativePointerAction, SolverConfig, WaitForToken } from './types';
import { errorMessage } from './types';

interface OperatorServiceOptions {
  config: SolverConfig;
  challenges: Map<string, ChallengeState>;
  log: ChallengeLog;
  waitForToken: WaitForToken;
  updateScreenshot: (state: ChallengeState) => Promise<void>;
  performRelativePointerAction: (state: ChallengeState, pointerAction: RelativePointerAction) => Promise<void>;
}

function asBodyRecord(body: unknown): Record<string, unknown> {
  return body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function buildOperatorUrl(config: SolverConfig, challengeId: string): string {
  const path = `/operator/${encodeURIComponent(challengeId)}`;
  const baseUrl = config.operatorViewBaseUrl || `http://127.0.0.1:${config.operatorPort}`;
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function parseCoordinate(record: Record<string, unknown>, xName: string, yName: string): Pick<RelativePointerAction, 'relativeX' | 'relativeY'> {
  const x = record[xName];
  const y = record[yName];
  if (x == null || y == null || (typeof x === 'string' && !x.trim()) || (typeof y === 'string' && !y.trim())) {
    throw new Error(`${xName} and ${yName} must be finite numbers between 0 and 1`);
  }

  const relativeX = Number(x);
  const relativeY = Number(y);
  if (
    !Number.isFinite(relativeX) ||
    !Number.isFinite(relativeY) ||
    relativeX < 0 ||
    relativeX > 1 ||
    relativeY < 0 ||
    relativeY > 1
  ) {
    throw new Error(`${xName} and ${yName} must be finite numbers between 0 and 1`);
  }

  return { relativeX, relativeY };
}

function parsePointerAction(body: unknown): RelativePointerAction {
  const record = asBodyRecord(body);
  const action = record.action;
  if (action !== 'tap' && action !== 'down' && action !== 'move' && action !== 'up') {
    throw new Error('action must be tap, down, move or up');
  }

  const position = parseCoordinate(record, 'x', 'y');
  return {
    action,
    relativeX: position.relativeX,
    relativeY: position.relativeY
  };
}

export function createOperatorService({
  config,
  challenges,
  log,
  waitForToken,
  updateScreenshot,
  performRelativePointerAction
}: OperatorServiceOptions) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  function getOperatorUrl(challengeId: string): string {
    return buildOperatorUrl(config, challengeId);
  }

  function startScreenshots(state: ChallengeState): void {
    void updateScreenshot(state);
    state.screenshotTimer = setInterval(() => updateScreenshot(state), config.screenshotIntervalMs);
  }

  async function waitForOperator(state: ChallengeState, autosolveError: unknown): Promise<string> {
    if (state.token) {
      log(state.challengeId, 'token was captured during autosolve error handling');
      return state.token;
    }

    const reason = errorMessage(autosolveError);
    state.status = 'operator_required';
    state.operatorUrl = getOperatorUrl(state.challengeId);
    state.autosolveError = reason;
    log(state.challengeId, 'operator interaction required', {
      operatorUrl: state.operatorUrl,
      reason
    });

    startScreenshots(state);
    await notifyManualSolveRequired({
      challengeId: state.challengeId,
      operatorUrl: state.operatorUrl,
      reason,
      config,
      log
    });

    log(state.challengeId, 'waiting for success token from operator');
    return waitForToken(state, config.operatorTimeoutMs);
  }

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, challenges: challenges.size });
  });

  app.get('/operator/:challengeId', (req, res) => {
    const state = challenges.get(req.params.challengeId);
    if (!state) {
      res.status(404).send('challenge not found');
      return;
    }

    log(state.challengeId, 'operator view opened');
    res.type('html').send(
      renderOperatorView({
        challengeId: state.challengeId,
        status: state.status,
        screenshotIntervalMs: config.screenshotIntervalMs
      })
    );
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

  app.post('/operator/:challengeId/pointer', async (req, res) => {
    const state = challenges.get(req.params.challengeId);
    if (!state) {
      res.status(404).json({ error: 'challenge not found' });
      return;
    }
    if (state.status !== 'operator_required' || !state.page) {
      res.status(409).json({ error: 'challenge is not ready for operator input' });
      return;
    }

    let pointerAction: RelativePointerAction;
    try {
      pointerAction = parsePointerAction(req.body);
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
      return;
    }

    try {
      await performRelativePointerAction(state, pointerAction);
      res.json({ ok: true });
    } catch (error) {
      log(state.challengeId, 'operator pointer action failed', { error: errorMessage(error) });
      res.status(500).json({ error: 'operator action failed' });
    }
  });

  return {
    app,
    getOperatorUrl,
    waitForOperator
  };
}
