import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middlewares/errorHandler.js';
import { sessionToken } from './middlewares/sessionToken.js';
import routes from './routes/index.js';

/**
 * `*` or a comma-separated allow-list of origins (the web app's). Auth travels in the
 * Authorization header, not cookies, so credentials are never allowed cross-origin.
 */
const corsOrigin = env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((origin) => origin.trim());

export function createApp() {
  const app = express();

  // Behind the frontend's /api rewrite and cloud load balancers — trust X-Forwarded-* for req.ip / protocol.
  app.set('trust proxy', true);

  app.use(helmet());
  app.use(cors({ origin: corsOrigin, maxAge: 600 }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(morgan(env.isProduction ? 'combined' : 'dev'));

  app.use('/api', sessionToken, routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
