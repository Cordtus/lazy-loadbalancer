import { Request, Response, NextFunction } from 'express';
import { appLogger } from '../src/logger';

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  const statusCode = res.statusCode !== 200 ? res.statusCode : 500;
  appLogger.error(`Error: ${err.message}`, { 
    stack: err.stack,
    method: req.method,
    url: req.url,
    statusCode
  });
  res.status(statusCode).json({
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    stack: process.env.NODE_ENV === 'production' ? '🥞' : err.stack
  });
}