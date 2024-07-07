import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import config from './config.js';

const logDir = path.join(process.cwd(), 'logs');

const createLogger = (filename: string, level: string) => {
  return winston.createLogger({
    level: level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ level, message, timestamp }) => {
        return `${timestamp} ${level}: ${message}`;
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
    ],
  });
};

export const balancerLogger = createLogger('balancer', config.logging.balancer);
export const crawlerLogger = createLogger('crawler', config.logging.crawler);
export const appLogger = createLogger('app', config.logging.app);

if (process.env.NODE_ENV !== 'production') {
  [balancerLogger, crawlerLogger, appLogger].forEach(logger => {
    logger.add(new winston.transports.Console({
      format: winston.format.simple(),
    }));
  });
}