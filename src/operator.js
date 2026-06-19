'use strict';

const express = require('express');
const { notifyManualSolveRequired } = require('./notifications');
const { renderOperatorView } = require('./operatorView');

function buildOperatorUrl(config, challengeId) {
  const path = `/operator/${encodeURIComponent(challengeId)}`;
  const baseUrl = config.operatorViewBaseUrl || `http://127.0.0.1:${config.operatorPort}`;
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function parseTap(body) {
  const x = body?.x;
  const y = body?.y;
  if (x == null || y == null || (typeof x === 'string' && !x.trim()) || (typeof y === 'string' && !y.trim())) {
    throw new Error('x and y must be finite numbers between 0 and 1');
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
    throw new Error('x and y must be finite numbers between 0 and 1');
  }

  return { relativeX, relativeY };
}

function createOperatorService({ config, challenges, log, waitForToken, updateScreenshot, clickAtRelativePosition }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  function getOperatorUrl(challengeId) {
    return buildOperatorUrl(config, challengeId);
  }

  function startScreenshots(state) {
    updateScreenshot(state);
    state.screenshotTimer = setInterval(() => updateScreenshot(state), config.screenshotIntervalMs);
  }

  async function waitForOperator(state, autosolveError) {
    if (state.token) {
      log(state.challengeId, 'token was captured during autosolve error handling');
      return state.token;
    }

    state.status = 'operator_required';
    state.operatorUrl = getOperatorUrl(state.challengeId);
    state.autosolveError = autosolveError.message;
    log(state.challengeId, 'operator interaction required', {
      operatorUrl: state.operatorUrl,
      reason: autosolveError.message
    });

    startScreenshots(state);
    await notifyManualSolveRequired({
      challengeId: state.challengeId,
      operatorUrl: state.operatorUrl,
      reason: autosolveError.message,
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

  app.post('/operator/:challengeId/tap', async (req, res) => {
    const state = challenges.get(req.params.challengeId);
    if (!state) {
      res.status(404).json({ error: 'challenge not found' });
      return;
    }
    if (state.status !== 'operator_required' || !state.page) {
      res.status(409).json({ error: 'challenge is not ready for operator input' });
      return;
    }

    let tap;
    try {
      tap = parseTap(req.body);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    await clickAtRelativePosition(state, tap);
    res.json({ ok: true });
  });

  return {
    app,
    getOperatorUrl,
    waitForOperator
  };
}

module.exports = {
  createOperatorService
};
