import type { Request, Response } from 'express';
import * as telegram from '../services/telegram.service.js';
import type { ChannelTeardownQuery, TelegramSetupBody, WebhookQuery } from '../validators/channelSetup.validator.js';
import { validatedQuery } from '../utils/validatedInput.js';

/** POST /api/telegram/setup — binds a Telegram bot to an agent version. */
export async function connectBot(req: Request<{}, unknown, TelegramSetupBody>, res: Response) {
  const { botToken, version_id, agent_id, commands } = req.body;
  const result = await telegram.connectTelegramBot(req.sessionToken, {
    botToken,
    versionId: version_id,
    agentId: agent_id,
    commands,
  });
  res.json({ success: true, ...result });
}

/** DELETE /api/telegram/setup?version_id=&agent_id= */
export async function disconnectBot(req: Request, res: Response) {
  const { version_id, agent_id } = validatedQuery<ChannelTeardownQuery>(req);
  const deleted = await telegram.disconnectTelegramBot(req.sessionToken, version_id, agent_id);
  res.json(deleted ? { success: true, deleted } : { success: true, deleted: 0, unset: 'telegram' });
}

/** POST /api/telegram/webhook?version_id= — always 200 so Telegram does not retry. */
export async function receiveUpdate(req: Request, res: Response) {
  res.json(await telegram.receiveTelegramUpdate(validatedQuery<WebhookQuery>(req).version_id, req.body ?? {}));
}

export function describeWebhook(_req: Request, res: Response) {
  res.json({
    ok: true,
    message: 'Telegram webhook — stream text (no reasoning), sendPhoto for images',
  });
}
