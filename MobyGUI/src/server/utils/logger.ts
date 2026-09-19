import pino from 'pino';
import { createLogBufferDestination } from './logBuffer.js';

const isDev = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');

// Create a multistream that writes to both stdout and the log buffer
const streams: pino.StreamEntry[] = [
  // Log buffer stream (always JSON for parsing)
  { level: logLevel as pino.Level, stream: createLogBufferDestination() as unknown as pino.DestinationStream },
];

// In development, use pino-pretty for console output
// In production, write JSON to stdout
if (isDev) {
  // We need to use a transport for pino-pretty, but transports don't work with multistream
  // So in dev, we'll write plain JSON to the buffer and use a separate pretty stream
  const pinoPretty = await import('pino-pretty');
  streams.push({
    level: logLevel as pino.Level,
    stream: pinoPretty.default({
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    }),
  });
} else {
  streams.push({ level: logLevel as pino.Level, stream: process.stdout });
}

export const logger = pino(
  { level: logLevel },
  pino.multistream(streams)
);

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
