import type { Request, Response } from 'express';
import * as channelDetails from '../services/channelDetails.service.js';
import type {
  ChannelLookupQuery,
  CreateChannelBody,
  UpdateChannelBody,
} from '../validators/channelDetails.validator.js';
import { validatedQuery } from '../utils/validatedInput.js';

/** GET /api/channel-details?id= | ?version_id= — one channel; no query lists them all. */
export async function getChannels(req: Request, res: Response) {
  const { id, version_id } = validatedQuery<ChannelLookupQuery>(req);
  const data = id
    ? await channelDetails.findChannel({ id })
    : version_id
      ? await channelDetails.findChannel({ versionId: version_id })
      : await channelDetails.listChannels();
  res.json({ success: true, data });
}

/** POST /api/channel-details — upserts a version's Telegram binding. */
export async function createChannel(req: Request<{}, unknown, CreateChannelBody>, res: Response) {
  const data = await channelDetails.upsertTelegramChannel(req.body);
  res.json({ success: true, data });
}

/** PUT /api/channel-details */
export async function updateChannel(req: Request<{}, unknown, UpdateChannelBody>, res: Response) {
  const data = await channelDetails.updateChannel(req.body);
  res.json({ success: true, data });
}

/** DELETE /api/channel-details?id= | ?version_id= */
export async function deleteChannel(req: Request, res: Response) {
  const { id, version_id } = validatedQuery<ChannelLookupQuery>(req);
  const deleted = await channelDetails.deleteChannel(id ? { id } : { versionId: version_id! });
  res.json({ success: true, deleted });
}
