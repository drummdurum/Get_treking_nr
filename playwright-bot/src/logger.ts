import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { config } from './config';

// Ensure log directory exists
if (!fs.existsSync(config.log.logDir)) {
  fs.mkdirSync(config.log.logDir, { recursive: true });
}

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, stack }) => {
  return stack
    ? `${timestamp} [${level}] ${message}\n${stack}`
    : `${timestamp} [${level}] ${message}`;
});

export const logger = winston.createLogger({
  level: config.log.level,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // Console – always coloured
    new winston.transports.Console({
      format: combine(
        colorize(),
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      ),
    }),
    // Rolling daily file
    new winston.transports.File({
      filename: path.join(config.log.logDir, 'bot.log'),
      maxsize:  5 * 1024 * 1024, // 5 MB
      maxFiles: 10,
      tailable: true,
    }),
    // Separate error log
    new winston.transports.File({
      level:    'error',
      filename: path.join(config.log.logDir, 'bot-errors.log'),
      maxsize:  5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});
