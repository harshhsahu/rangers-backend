import 'dotenv/config';
import Joi from 'joi';

/** Unset and empty values both mean "not configured". */
const optional = Joi.string().trim().empty('');
const optionalUrl = Joi.string()
  .trim()
  .empty('')
  .uri({ scheme: ['http', 'https'] });

interface EnvValues {
  NODE_ENV: string;
  PORT: number;
  CORS_ORIGIN: string;
  /** Same value as the frontend's NEXT_PUBLIC_ENV; prefixes the local_token cookie name. */
  APP_ENV?: string;

  PYTHON_SERVER_URL?: string;
  SERVER_URL?: string;
  FRONTEND_URL?: string;
  PROXY_URL: string;

  ORG_ID?: string;
  FOLDER_ID?: string;
  ACCESS_KEY?: string;
  GTWY_PAUTH_KEY?: string;

  MONGODB_URI?: string;

  TELEGRAM_WEBHOOK_BASE_URL?: string;
  RANGER_PUBLIC_URL?: string;

  SCHEDULER_ADMIN_KEY?: string;
  DISCORD_INTERNAL_SECRET?: string;
}

const schema = Joi.object<EnvValues>({
  NODE_ENV: Joi.string().trim().empty('').default('development'),
  PORT: Joi.number().integer().positive().empty('').default(4000),
  CORS_ORIGIN: Joi.string().trim().empty('').default('*'),
  APP_ENV: optional,

  PYTHON_SERVER_URL: optionalUrl,
  SERVER_URL: optionalUrl,
  FRONTEND_URL: optionalUrl,
  PROXY_URL: optionalUrl.default('https://routes.msg91.com'),

  ORG_ID: optional,
  FOLDER_ID: optional,
  ACCESS_KEY: optional,
  GTWY_PAUTH_KEY: optional,

  MONGODB_URI: optional,

  TELEGRAM_WEBHOOK_BASE_URL: optionalUrl,
  RANGER_PUBLIC_URL: optionalUrl,

  SCHEDULER_ADMIN_KEY: optional,
  DISCORD_INTERNAL_SECRET: optional,
}).unknown(true); // process.env holds far more than this service reads

const { value, error } = schema.validate(process.env, { abortEarly: false, errors: { wrap: { label: false } } });
if (error) {
  // Fail fast: a malformed value would otherwise surface as a confusing runtime error much later.
  throw new Error(`Invalid environment configuration:\n${error.details.map((d) => `  ${d.message}`).join('\n')}`);
}

/** An origin without its trailing slash, so paths can be appended safely. */
const origin = (url: string | undefined) => url?.replace(/\/$/, '');

const values: EnvValues = {
  ...value,
  PYTHON_SERVER_URL: origin(value.PYTHON_SERVER_URL),
  SERVER_URL: origin(value.SERVER_URL),
  FRONTEND_URL: origin(value.FRONTEND_URL),
  PROXY_URL: origin(value.PROXY_URL)!,
  TELEGRAM_WEBHOOK_BASE_URL: origin(value.TELEGRAM_WEBHOOK_BASE_URL),
  RANGER_PUBLIC_URL: origin(value.RANGER_PUBLIC_URL),
};

export const env = {
  ...values,
  isProduction: values.NODE_ENV === 'production',
  /**
   * Public origin GTWY agents and EasyCron call back on. Separate from TELEGRAM_WEBHOOK_BASE_URL
   * so a developer can point callbacks at a tunnel to their own machine while Telegram keeps
   * delivering to the shared deployment.
   */
  publicUrl: values.RANGER_PUBLIC_URL || values.TELEGRAM_WEBHOOK_BASE_URL || values.FRONTEND_URL || '',
  /** Where Telegram delivers webhook updates. */
  telegramWebhookBaseUrl: values.TELEGRAM_WEBHOOK_BASE_URL || values.FRONTEND_URL || '',
} as const;
