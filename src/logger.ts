// logger.ts
import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import config from './config.js';

const logDir = path.join(process.cwd(), 'logs');

const createLogger = (filename: string, level: string) => {
  const logger = winston.createLogger({
    level: level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ level, message, timestamp, ...metadata }) => {
        let msg = `${timestamp} ${level}: ${message}`;
        if (Object.keys(metadata).length > 0) {
          msg += JSON.stringify(metadata);
        }
        return msg;
      })
    ),
    transports: [
      new winston.transports.DailyRotateFile({
        filename: path.join(logDir, `${filename}-%DATE%.log`),
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d'
      }),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        )
      })
    ],
  });

  return logger;
};

// Use the levels from the config file
export const balancerLogger = createLogger('balancer', config.logging.balancer);
export const crawlerLogger = createLogger('crawler', config.logging.crawler);
export const appLogger = createLogger('app', config.logging.app);