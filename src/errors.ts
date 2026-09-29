export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RULE_FROZEN'
  | 'ROUND_FROZEN'
  | 'BAD_STATE'
  | 'IDEMPOTENCY_REPLAY'
  | 'QUALIFICATION'
  | 'CAPACITY'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new AppError(code, message, details);
}
