import type { NextFunction, Request, Response } from 'express';
import type { Settings } from '../config/settings.js';

export function createApiKeyMiddleware(settings: Settings) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header =
      req.header('authorization')?.replace(/^Bearer\s+/i, '') ??
      req.header('x-api-key') ??
      '';

    if (!header || header !== settings.apiSecretKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
