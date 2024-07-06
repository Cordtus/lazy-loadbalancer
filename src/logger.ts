import winston from 'winston';
import path from 'path';
import config from './config.js';

const logDir = path.join(process.cwd(), 'logs');

const createLogger = (filename: string, level: string) => {
  return winston.createLogger({
    level: level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.File({ filename: path.join(logDir, `${filename}.log`) }),
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