import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import * as rangerAi from '../services/rangerAi.service.js';
import { errorMessage } from '../utils/AppError.js';
import type { BuildChatBody, PromptDraftBody, UpdateChatBody } from '../validators/rangerAi.validator.js';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Nginx buffers proxied responses by default, which would batch the whole stream.
  'X-Accel-Buffering': 'no',
};

/** POST /api/ranger-ai/chat — "Build with AI". */
export async function buildChat(req: Request<{}, unknown, BuildChatBody>, res: Response) {
  const { message, thread_id } = req.body;
  const reply = await rangerAi.buildChat(message, thread_id);
  res.json({ success: true, ...reply, thread_id });
}

/** POST /api/ranger-ai/prompt — drafts a system prompt for the onboarding wizard. */
export async function draftPrompt(req: Request<{}, unknown, PromptDraftBody>, res: Response) {
  const prompt = await rangerAi.draftPrompt(req.body);
  res.json({ success: true, prompt });
}

/**
 * POST /api/ranger-ai/update — "Update the ranger" chat, always answered as SSE.
 * The client reads tool_call / tool_result events to know what changed on screen.
 */
export async function updateChat(req: Request<{}, unknown, UpdateChatBody>, res: Response) {
  const body = req.body;
  const reply = await rangerAi.updateChat({
    sessionToken: req.sessionToken,
    message: body.message,
    threadId: body.thread_id,
    agentId: body.agent_id,
    versionId: body.version_id,
    orgTimezone: body.org_timezone,
    modelType: body.model_type,
    availableKnowledgeBases: body.available_knowledge_bases,
  });

  res.status(200).set(SSE_HEADERS);

  if (reply.kind === 'text') {
    // A non-streamed answer, re-emitted as the event sequence a stream would produce.
    res.send(
      [{ event: 'start' }, { event: 'delta', content: reply.text }, { event: 'done' }]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('')
    );
    return;
  }

  res.flushHeaders();
  const stream = Readable.fromWeb(reply.body);
  // Stop reading upstream if the browser goes away mid-answer.
  res.on('close', () => stream.destroy());
  stream.on('error', (error) => {
    console.error('[ranger-ai] update stream failed', errorMessage(error));
    res.end();
  });
  stream.pipe(res);
}
