import { Router } from 'express';
import * as telegram from '../controllers/telegram.controller.js';
import { validate } from '../middlewares/validate.js';
import {
  channelTeardownSchema,
  telegramSetupSchema,
  telegramWebhookSchema,
} from '../validators/channelSetup.validator.js';

const router = Router();

router
  .route('/setup')
  .post(validate(telegramSetupSchema), telegram.connectBot)
  .delete(validate(channelTeardownSchema), telegram.disconnectBot);

router.route('/webhook').get(telegram.describeWebhook).post(validate(telegramWebhookSchema), telegram.receiveUpdate);

export default router;
