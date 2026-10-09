import { Router } from 'express';
import * as channelDetails from '../controllers/channelDetails.controller.js';
import { validate } from '../middlewares/validate.js';
import {
  createChannelSchema,
  deleteChannelSchema,
  getChannelsSchema,
  updateChannelSchema,
} from '../validators/channelDetails.validator.js';

const router = Router();

router
  .route('/')
  .get(validate(getChannelsSchema), channelDetails.getChannels)
  .post(validate(createChannelSchema), channelDetails.createChannel)
  .put(validate(updateChannelSchema), channelDetails.updateChannel)
  .delete(validate(deleteChannelSchema), channelDetails.deleteChannel);

export default router;
