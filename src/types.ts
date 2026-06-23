import type { BrowserContext, Page } from 'playwright';

export type ChallengeStatus = 'queued' | 'running' | 'operator_required';

export interface SolverConfig {
  solvePort: number;
  solveHost: string;
  operatorPort: number;
  operatorHost: string;
  autosolveDelayMs: number;
  autosolveTimeoutMs: number;
  operatorTimeoutMs: number;
  operatorViewBaseUrl: string;
  callbackTimeoutMs: number;
  telegramBotToken: string;
  telegramChatId: string;
  telegramNotifyTimeoutMs: number;
  userAgent: string;
  display: string;
  browserChannel: string;
  viewportWidth: number;
  viewportHeight: number;
  screenshotIntervalMs: number;
  captchaAllowedHosts: Set<string>;
  callbackAllowedHosts: Set<string>;
}

export interface ChallengeState {
  challengeId: string;
  captchaUrl: string;
  callbackUrl: string;
  createdAt: Date;
  status: ChallengeStatus;
  tokenWaiters: Set<(token: string) => void>;
  autosolveError?: string;
  context?: BrowserContext;
  done?: boolean;
  lastScreenshotAt?: Date;
  lastScreenshotError?: string;
  operatorUrl?: string;
  page?: Page;
  screenshot?: Buffer;
  screenshotTimer?: NodeJS.Timeout;
  token?: string;
}

export interface LogDetails {
  [key: string]: unknown;
}

export type ChallengeLog = (challengeId: string, message: string, details?: LogDetails) => void;

export type WaitForToken = (state: ChallengeState, timeoutMs: number) => Promise<string>;

export interface RelativePoint {
  relativeX: number;
  relativeY: number;
}

export interface RelativePointerAction extends RelativePoint {
  action: 'tap' | 'down' | 'move' | 'up';
}

export interface FinishPayload {
  status: 'ok' | 'failed';
  token?: string;
  error?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
