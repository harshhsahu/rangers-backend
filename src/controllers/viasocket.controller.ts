import type { Request, Response } from 'express';
import * as viasocket from '../services/viasocket.service.js';
import type { IdParams } from '../validators/common.js';
import type {
  AddAppToolBody,
  AppSearchQuery,
  AppToolsQuery,
  AuthenticationsBody,
  EmbedTokenBody,
  EnableToolBody,
  RunToolBody,
  ServiceIdParams,
  TokenBody,
} from '../validators/viasocket.validator.js';
import { validatedQuery } from '../utils/validatedInput.js';

/** GET /api/viasocket/apps?key= — catalog search, or the popular list when key is empty. */
export async function searchApps(req: Request, res: Response) {
  const { key = '' } = validatedQuery<AppSearchQuery>(req);
  const apps = await viasocket.searchApps(req.sessionToken, key);
  res.json({ success: true, apps });
}

/** GET /api/viasocket/apps/:serviceId/versions — an app's actions and triggers. */
export async function listVersions(req: Request<ServiceIdParams>, res: Response) {
  const versions = await viasocket.listVersions(req.sessionToken, req.params.serviceId);
  res.json({ success: true, ...versions });
}

/** POST /api/viasocket/register — verifies the org embed token so the connect popup can open. */
export async function register(req: Request<{}, unknown, EmbedTokenBody>, res: Response) {
  const data = await viasocket.registerEmbed(req.sessionToken, req.body.embed_token);
  res.json({ success: true, data });
}

/** POST /api/viasocket/authentications — the user's connections for one app. */
export async function findAuthentications(req: Request<{}, unknown, AuthenticationsBody>, res: Response) {
  const result = await viasocket.findAuthentications(req.sessionToken, req.body);
  res.json({ success: true, ...result });
}

/** POST /api/viasocket/token — a per-org embed token for the connect popup. */
export async function signToken(req: Request<{}, unknown, TokenBody>, res: Response) {
  const embedToken = await viasocket.signEmbedToken(req.sessionToken, req.body);
  res.json({ success: true, embed_token: embedToken });
}

/** GET /api/viasocket/app-tools?agent_id=&version_id= */
export async function listAppTools(req: Request, res: Response) {
  const { agent_id, version_id } = validatedQuery<AppToolsQuery>(req);
  const result = await viasocket.listAppTools(req.sessionToken, agent_id, version_id);
  res.json({ success: true, ...result });
}

/** POST /api/viasocket/app-tools — adds every action of one connected app as one agent tool. */
export async function addAppTool(req: Request<{}, unknown, AddAppToolBody>, res: Response) {
  const tool = await viasocket.addAppTool(req.sessionToken, req.body);
  res.json({ success: true, tool });
}

/** DELETE /api/viasocket/app-tools/:id */
export async function deleteAppTool(req: Request<IdParams>, res: Response) {
  await viasocket.deleteAppTool(req.sessionToken, req.params.id);
  res.json({ success: true });
}

/** POST /api/viasocket/app-tools/:id/run — called by GTWY with the tool's run key header. */
export async function runAppTool(req: Request<IdParams, unknown, RunToolBody>, res: Response) {
  const { status, body } = await viasocket.runAppTool(
    req.params.id,
    req.get('x-viasocket-tool-key'),
    req.body
  );
  res.status(status).json(body);
}

/** POST /api/viasocket/tools — registers one action as its own GTWY function. */
export async function enableActionTool(req: Request<{}, unknown, EnableToolBody>, res: Response) {
  const tool = await viasocket.enableActionTool(req.sessionToken, req.body);
  res.json({ success: true, tool });
}

/** POST /api/viasocket/run/:id — fallback run for single-action tools. */
export async function runActionTool(req: Request<IdParams, unknown, RunToolBody>, res: Response) {
  const { status, body } = await viasocket.runActionTool(req.params.id, req.body);
  res.status(status).json(body);
}
