'use strict';

function formatManualSolveMessage({ challengeId, operatorUrl, reason }) {
  return [
    'Manual captcha solving required',
    `Challenge: ${challengeId}`,
    `Operator URL: ${operatorUrl}`,
    `Reason: ${reason}`
  ].join('\n');
}

async function notifyTelegram({ challengeId, operatorUrl, reason, config, log }) {
  const { telegramBotToken, telegramChatId, telegramNotifyTimeoutMs } = config;
  if (!telegramBotToken || !telegramChatId) {
    log(challengeId, 'telegram notification skipped', {
      reason: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not both configured'
    });
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(telegramNotifyTimeoutMs),
    body: JSON.stringify({
      chat_id: telegramChatId,
      text: formatManualSolveMessage({ challengeId, operatorUrl, reason }),
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`telegram sendMessage returned ${response.status}: ${text.slice(0, 500)}`);
  }

  log(challengeId, 'telegram notification sent', { channel: 'telegram' });
}

async function notifyManualSolveRequired({ challengeId, operatorUrl, reason, config, log }) {
  log(challengeId, 'operator notification required', { operatorUrl, reason });

  try {
    await notifyTelegram({ challengeId, operatorUrl, reason, config, log });
  } catch (error) {
    log(challengeId, 'telegram notification failed', { error: error.message });
  }
}

module.exports = {
  notifyManualSolveRequired
};
