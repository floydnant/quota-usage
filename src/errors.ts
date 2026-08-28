import type { ErrorCode, Provider, UsageErrorData } from './types.js';

export class UsageError extends Error {
  readonly data: UsageErrorData;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      provider?: Provider;
      accountLabel?: string;
      retryable?: boolean;
      details?: Record<string, boolean | number | string | null>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'UsageError';
    this.data = {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.accountLabel === undefined ? {} : { accountLabel: options.accountLabel }),
      ...(options.details === undefined ? {} : { details: options.details }),
    };
  }
}

export function asUsageError(
  error: unknown,
  fallback: Omit<UsageErrorData, 'message'> & { message?: string },
): UsageErrorData {
  if (error instanceof UsageError) return error.data;
  return {
    code: fallback.code,
    message: fallback.message ?? (error instanceof Error ? error.message : 'Unknown failure'),
    retryable: fallback.retryable,
    ...(fallback.provider === undefined ? {} : { provider: fallback.provider }),
    ...(fallback.accountLabel === undefined ? {} : { accountLabel: fallback.accountLabel }),
  };
}
