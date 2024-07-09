import { Request, Response, NextFunction } from 'express';
import { balancerLogger, crawlerLogger, appLogger } from './logger.js';



export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const sanitizedHeaders = { ...req.headers };
  delete sanitizedHeaders.authorization;
  delete sanitizedHeaders.cookie;

  balancerLogger.info(`${req.method} ${req.url}`, { 
    headers: sanitizedHeaders, 
    body: req.body,
    params: req.params,
    query: req.query
  });
  next();
}