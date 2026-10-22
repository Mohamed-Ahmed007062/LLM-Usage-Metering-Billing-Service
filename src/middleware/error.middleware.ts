import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
  const message = err.message || 'Internal Server Error';

  // Redact any potential sensitive strings (e.g. sk_test, whsec)
  const sanitizedMessage = String(message).replace(/(sk_test_[a-zA-Z0-9]+|whsec_[a-zA-Z0-9]+)/g, '[REDACTED]');

  if (statusCode >= 500) {
    console.error('[SERVER ERROR]', sanitizedMessage);
  }

  res.status(statusCode).json({
    error: err.name || 'Error',
    message: sanitizedMessage,
    ...(statusCode === 429 && err.retryAfter ? { retry_after: err.retryAfter } : {}),
  });
}
