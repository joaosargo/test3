import type { Request, Response, NextFunction } from 'express';

/**
 * Security headers applied to auth responses (security-design "Encryption,
 * Secrets, GDPR PII & Security Headers"). Callback responses additionally get
 * `Cache-Control: no-store` so tokens are never cached.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
}
