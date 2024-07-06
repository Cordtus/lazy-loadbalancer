import { Request, Response, NextFunction } from 'express';
import logger from '../src/logger';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const sanitizedHeaders = { ...req.headers };
  delete sanitizedHeaders.authorization;
  delete sanitizedHeaders.cookie;

  logger.info(`${req.method} ${req.url}`, { 
    headers: sanitizedHeaders, 
    body: req.body,
    params: req.params,
    query: req.query
  });
  next();
}