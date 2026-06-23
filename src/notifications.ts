import type { ChallengeLog, SolverConfig } from './types';
import { errorMessage } from './types';

interface ManualSolveNotification {
  challengeId: string;
  operatorUrl: string;
  reason: string;
  config: SolverConfig;
  log: ChallengeLog;
}

function formatManualSolveMessage({
  challengeId,
  operatorUrl,
  reason
}: Pick<ManualSolveNotification, 'challengeId' | 'operatorUrl' | 'reason'>): string {
  return [
    'Manual captcha solving required',
    `Challenge: ${challengeId}`,
    `Operator URL: ${operatorUrl}`,
    `Reason: ${reason}`
  ].join('\n');
}

async function notifyTelegram({ challengeId, operatorUrl, reason, config, log }: ManualSolveNotification): Promise<void> {
  const { telegramBotToken, telegramChatId, telegramNotifyTimeoutMs } = config;
  if (!telegramBotToken || !telegramChatId) {
    log(challengeId, 'telegram notification skipped', {
      reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured'
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

export async function notifyManualSolveRequired({
  challengeId,
  operatorUrl,
  reason,
  config,
  log
}: ManualSolveNotification): Promise<void> {
  try {
    await notifyTelegram({ challengeId, operatorUrl, reason, config, log });
  } catch (error) {
    log(challengeId, 'telegram notification failed', { error: errorMessage(error) });
  }
}
