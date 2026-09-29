export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const ERR = {
  NOT_FOUND: (what: string) => new AppError('NOT_FOUND', `${what}不存在`, 404),
  VALIDATION: (msg: string) => new AppError('VALIDATION_ERROR', msg, 400),
  CONFLICT: (code: string, msg: string) => new AppError(code, msg, 409),
  FROZEN: (msg: string) => new AppError('RESULT_FROZEN', msg, 409),
  ALREADY_DONE: (msg: string) => new AppError('IDEMPOTENT_REPLAY', msg, 409),
  CAPACITY: (msg: string) => new AppError('CAPACITY_VIOLATION', msg, 422),
  CONCURRENT: (msg: string) => new AppError('CONCURRENT_CONFIRM', msg, 409),
}
