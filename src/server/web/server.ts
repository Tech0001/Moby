import express, { Express, Request, Response, NextFunction } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createChildLogger } from '../utils/logger.js';
import type { WebConfig } from '../config/schema.js';

const logger = createChildLogger('web-server');

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WebServerOptions {
  config: WebConfig;
}

export function createWebServer(options: WebServerOptions): Express {
  const { config } = options;

  const app = express();

  // Trust proxy if configured (for running behind reverse proxy)
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Session configuration
  if (!config.sessionSecret) {
    throw new Error('Session secret is required - check config loading');
  }

  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: config.trustProxy, // Use secure cookies behind HTTPS proxy
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax',
      },
    })
  );

  // Request logging
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.debug(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration,
        },
        'Request handled'
      );
    });
    next();
  });

  // Error handling
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error({ error: err.message, stack: err.stack }, 'Request error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/**
 * Start the web server
 */
export function startServer(app: Express, config: WebConfig): Promise<void> {
  return new Promise((resolve) => {
    app.listen(config.port, config.host, () => {
      logger.info(
        { host: config.host, port: config.port },
        'Web server started'
      );
      resolve();
    });
  });
}
