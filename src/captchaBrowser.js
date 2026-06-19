'use strict';

const { chromium } = require('playwright');

function createCaptchaBrowser({ config, log, waitForToken }) {
  let browserPromise;

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

  function captureTokenFromResponse(state, response) {
    if (!response.url().includes('/method/captchaNotRobot.check')) return;

    log(state.challengeId, 'captcha check response received', { status: response.status() });

    response
      .json()
      .then((payload) => {
        const token = extractSuccessToken(payload);
        if (!token || state.token) return;

        state.token = token;
        log(state.challengeId, 'success token captured');
        for (const waiter of state.tokenWaiters) waiter(token);
      })
      .catch((error) => {
        log(state.challengeId, 'captcha check response parse failed', { error: error.message });
      });
  }

  async function openChallengePage(state) {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent: config.userAgent,
      viewport: { width: config.viewportWidth, height: config.viewportHeight },
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow'
    });
    const page = await context.newPage();

    state.context = context;
    state.page = page;
    state.status = 'running';
    page.on('response', (response) => captureTokenFromResponse(state, response));
  }

  async function clickElementCenter(page, locator) {
    const box = await locator.boundingBox().catch(() => undefined);
    if (!box) {
      await locator.click({ delay: 120, timeout: 3000, force: true });
      return;
    }

    const x = Math.round(box.x + Math.min(22, box.width / 2));
    const y = Math.round(box.y + box.height / 2);
    await page.mouse.click(x, y, { delay: 120 });
  }

  async function clickCheckbox(state) {
    const { page, challengeId } = state;
    const checkbox = page.locator('#not-robot-captcha-checkbox').first();

    if (await checkbox.isVisible({ timeout: 3000 }).catch(() => false)) {
      await clickElementCenter(page, checkbox);
      log(challengeId, 'autoclick completed', { strategy: 'checkbox-selector' });
      return 'checkbox-selector';
    }

    const label = page
      .getByText(/\u044f \u043d\u0435 \u0440\u043e\u0431\u043e\u0442|i'?m not a robot|i am not a robot/i)
      .first();
    if (await label.isVisible({ timeout: 1000 }).catch(() => false)) {
      await clickElementCenter(page, label);
      log(challengeId, 'autoclick completed', { strategy: 'label-text' });
      return 'label-text';
    }

    const viewport = page.viewportSize() || { width: config.viewportWidth, height: config.viewportHeight };
    const x = Math.round(viewport.width / 2 - 55);
    const y = Math.round(viewport.height / 2 + 80);
    await page.mouse.click(x, y, { delay: 120 });
    log(challengeId, 'autoclick completed', { strategy: 'fallback-coordinate' });
    return 'fallback-coordinate';
  }

  async function tryAutosolve(state) {
    log(state.challengeId, 'navigating to captcha');
    const navigationResponse = await state.page.goto(state.captchaUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    log(state.challengeId, 'captcha navigation completed', {
      status: navigationResponse?.status()
    });

    await state.page.waitForTimeout(config.autosolveDelayMs);
    const strategy = await clickCheckbox(state);

    log(state.challengeId, 'waiting for success token after autoclick', { strategy });
    return waitForToken(state, config.autosolveTimeoutMs);
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

  async function clickAtRelativePosition(state, { relativeX, relativeY }) {
    const viewport = state.page.viewportSize() || { width: config.viewportWidth, height: config.viewportHeight };
    const x = relativeX * viewport.width;
    const y = relativeY * viewport.height;

    log(state.challengeId, 'operator tap received', {
      relativeX,
      relativeY,
      x,
      y,
      viewport
    });

    await state.page.mouse.click(x, y, { delay: 80 });
  }

  async function closeBrowser() {
    const browser = await browserPromise?.catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  return {
    closeBrowser,
    clickAtRelativePosition,
    openChallengePage,
    tryAutosolve,
    updateScreenshot
  };
}

module.exports = {
  createCaptchaBrowser
};
