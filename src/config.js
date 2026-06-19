'use strict';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const DEFAULTS = {
  solvePort: 3000,
  solveHost: '127.0.0.1',
  operatorPort: 3001,
  operatorHost: '0.0.0.0',
  autosolveDelayMs: 3000,
  autosolveTimeoutMs: 15000,
  operatorTimeoutMs: 180000,
  operatorViewBaseUrl: '',
  callbackTimeoutMs: 10000,
  telegramBotToken: '',
  telegramChatId: '',
  telegramNotifyTimeoutMs: 5000,
  userAgent: DEFAULT_USER_AGENT,
  display: ':99',
  browserChannel: '',
  viewportWidth: 1280,
  viewportHeight: 800,
  screenshotIntervalMs: 1000,
  captchaAllowedHosts: 'id.vk.ru',
  callbackAllowedHosts: '127.0.0.1,localhost,::1,host.docker.internal'
};

function envString(env, name, fallback) {
  const value = env[name];
  return value == null || value === '' ? fallback : value;
}

function envNumber(env, name, fallback) {
  const value = env[name];
  if (value == null || String(value).trim() === '') return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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

function formatAllowedHosts(allowedHosts) {
  return Array.from(allowedHosts).join(', ');
}

function loadConfig(env = process.env) {
  const solvePortFallback = envNumber(env, 'PORT', DEFAULTS.solvePort);

  return {
    solvePort: envNumber(env, 'SOLVE_PORT', solvePortFallback),
    solveHost: envString(env, 'SOLVE_HOST', DEFAULTS.solveHost),
    operatorPort: envNumber(env, 'OPERATOR_PORT', DEFAULTS.operatorPort),
    operatorHost: envString(env, 'OPERATOR_HOST', DEFAULTS.operatorHost),
    autosolveDelayMs: envNumber(env, 'AUTOSOLVE_DELAY_MS', DEFAULTS.autosolveDelayMs),
    autosolveTimeoutMs: envNumber(env, 'AUTOSOLVE_TIMEOUT_MS', DEFAULTS.autosolveTimeoutMs),
    operatorTimeoutMs: envNumber(env, 'OPERATOR_TIMEOUT_MS', DEFAULTS.operatorTimeoutMs),
    operatorViewBaseUrl: envString(env, 'OPERATOR_VIEW_BASE_URL', DEFAULTS.operatorViewBaseUrl),
    callbackTimeoutMs: envNumber(env, 'CALLBACK_TIMEOUT_MS', DEFAULTS.callbackTimeoutMs),
    telegramBotToken: envString(env, 'TELEGRAM_BOT_TOKEN', DEFAULTS.telegramBotToken),
    telegramChatId: envString(env, 'TELEGRAM_CHAT_ID', DEFAULTS.telegramChatId),
    telegramNotifyTimeoutMs: envNumber(env, 'TELEGRAM_NOTIFY_TIMEOUT_MS', DEFAULTS.telegramNotifyTimeoutMs),
    userAgent: envString(env, 'BROWSER_UA', DEFAULTS.userAgent),
    display: envString(env, 'DISPLAY', DEFAULTS.display),
    browserChannel: envString(env, 'BROWSER_CHANNEL', DEFAULTS.browserChannel),
    viewportWidth: envNumber(env, 'VIEWPORT_WIDTH', DEFAULTS.viewportWidth),
    viewportHeight: envNumber(env, 'VIEWPORT_HEIGHT', DEFAULTS.viewportHeight),
    screenshotIntervalMs: envNumber(
      env,
      'OPERATOR_SCREENSHOT_INTERVAL_MS',
      DEFAULTS.screenshotIntervalMs
    ),
    captchaAllowedHosts: parseAllowedHosts(env.CAPTCHA_ALLOWED_HOSTS, DEFAULTS.captchaAllowedHosts),
    callbackAllowedHosts: parseAllowedHosts(env.CALLBACK_ALLOWED_HOSTS, DEFAULTS.callbackAllowedHosts)
  };
}

module.exports = {
  DEFAULTS,
  formatAllowedHosts,
  loadConfig,
  normalizeHost
};
