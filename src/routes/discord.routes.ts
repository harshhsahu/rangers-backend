import { Router } from 'express';
import { env } from '../config/env.js';
import * as discord from '../controllers/discord.controller.js';
import { requireHeaderSecret } from '../middlewares/requireHeaderSecret.js';
import { validate } from '../middlewares/validate.js';
import { channelTeardownSchema, discordRelaySchema, discordSetupSchema } from '../validators/channelSetup.validator.js';

const router = Router();

router
  .route('/setup')
  .post(validate(discordSetupSchema), discord.connectBot)
  .delete(validate(channelTeardownSchema), discord.disconnectBot);

router.get('/webhook', discord.describeWebhook);
// Open when DISCORD_INTERNAL_SECRET is unset (local relays); otherwise the header must match.
router.post(
  '/webhook',
  requireHeaderSecret('x-discord-internal-secret', () => env.DISCORD_INTERNAL_SECRET, { optional: true }),
  validate(discordRelaySchema),
  discord.relayMessage
);

export default router;
