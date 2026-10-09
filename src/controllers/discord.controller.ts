import type { Request, Response } from 'express';
import * as discord from '../services/discord.service.js';
import { errorMessage } from '../utils/AppError.js';
import type {
  ChannelTeardownQuery,
  DiscordRelayBody,
  DiscordSetupBody,
  WebhookQuery,
} from '../validators/channelSetup.validator.js';
import { validatedQuery } from '../utils/validatedInput.js';

/** POST /api/discord/setup — validates the token on the Gateway, then binds the bot. */
export async function connectBot(req: Request<{}, unknown, DiscordSetupBody>, res: Response) {
  const { botToken, version_id, agent_id } = req.body;
  const result = await discord.connectDiscordBot(req.sessionToken, {
    botToken,
    versionId: version_id,
    agentId: agent_id,
  });
  res.json({ success: true, ...result });
}

/** DELETE /api/discord/setup?version_id=&agent_id= */
export async function disconnectBot(req: Request, res: Response) {
  const { version_id, agent_id } = validatedQuery<ChannelTeardownQuery>(req);
  const deleted = await discord.disconnectDiscordBot(req.sessionToken, version_id, agent_id);
  res.json(deleted ? { success: true, deleted } : { success: true, deleted: 0, unset: 'discord' });
}

/** POST /api/discord/webhook?version_id= — relay entry point; failures are acked, not retried. */
export async function relayMessage(req: Request<{}, unknown, DiscordRelayBody>, res: Response) {
  try {
    res.json(await discord.relayDiscordMessage(validatedQuery<WebhookQuery>(req).version_id, req.body.message));
  } catch (error) {
    console.error('[discord] webhook failed', error);
    res.json({ ok: true, error: errorMessage(error) });
  }
}

export function describeWebhook(_req: Request, res: Response) {
  res.json({
    ok: true,
    message: 'Discord webhook — stream text (no reasoning), embeds for images, DMs only',
  });
}
