/**
 * Structured Logging Utility
 */

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const currentLogLevel = process.env.LOG_LEVEL 
  ? LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] || LOG_LEVELS.INFO
  : LOG_LEVELS.INFO;

function log(level, message, data = {}) {
  if (level > currentLogLevel) return;

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: Object.keys(LOG_LEVELS)[level],
    message,
    ...data,
  };

  const logString = JSON.stringify(logEntry);
  
  switch (level) {
    case LOG_LEVELS.ERROR:
      console.error(logString);
      break;
    case LOG_LEVELS.WARN:
      console.warn(logString);
      break;
    case LOG_LEVELS.INFO:
      console.log(logString);
      break;
    case LOG_LEVELS.DEBUG:
      console.debug(logString);
      break;
  }
}

export const logger = {
  error: (message, data) => log(LOG_LEVELS.ERROR, message, data),
  warn: (message, data) => log(LOG_LEVELS.WARN, message, data),
  info: (message, data) => log(LOG_LEVELS.INFO, message, data),
  debug: (message, data) => log(LOG_LEVELS.DEBUG, message, data),
};
