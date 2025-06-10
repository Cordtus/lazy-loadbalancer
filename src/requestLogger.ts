import { Request, Response, NextFunction } from 'express';
import { balancerLogger } from './logger.js';
import { performance } from 'perf_hooks';

export interface RequestLoggerOptions {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logBody: boolean;
  logHeaders: boolean;
  logTiming: boolean;
}

const defaultOptions: RequestLoggerOptions = {
  logLevel: 'debug',
  logBody: false,
  logHeaders: false,
  logTiming: true,
};

export function createRequestLogger(options?: Partial<RequestLoggerOptions>) {
  const config = { ...defaultOptions, ...options };
  
  return (req: Request, res: Response, next: NextFunction) => {
    const start = performance.now();
    
    // Log incoming request
    if (config.logLevel === 'debug') {
      const logData: any = {
        method: req.method,
        url: req.url,
        userAgent: req.get('User-Agent'),
        ip: req.ip || req.connection.remoteAddress,
      };

      if (config.logHeaders) {
        const sanitizedHeaders = { ...req.headers };
        delete sanitizedHeaders.authorization;
        delete sanitizedHeaders.cookie;
        logData.headers = sanitizedHeaders;
      }

      if (config.logBody && req.body) {
        logData.body = req.body;
      }

      if (req.params && Object.keys(req.params).length > 0) {
        logData.params = req.params;
      }

      if (req.query && Object.keys(req.query).length > 0) {
        logData.query = req.query;
      }

      balancerLogger[config.logLevel](`→ ${req.method} ${req.url}`, logData);
    }

    // Log response when finished
    res.on('finish', () => {
      const duration = performance.now() - start;
      const logLevel = res.statusCode >= 400 ? 'warn' : config.logLevel;
      
      const responseData: any = {
        statusCode: res.statusCode,
        duration: `${duration.toFixed(2)}ms`,
      };

      if (config.logTiming) {
        responseData.timing = {
          start: start,
          end: performance.now(),
          duration: duration,
        };
      }

      balancerLogger[logLevel](`← ${req.method} ${req.url} ${res.statusCode} ${duration.toFixed(2)}ms`, responseData);
    });

    next();
  };
}

// Export the default logger for backward compatibility
export const requestLogger = createRequestLogger();
