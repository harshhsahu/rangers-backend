import { Router } from 'express';
import * as rangerAi from '../controllers/rangerAi.controller.js';
import { validate } from '../middlewares/validate.js';
import { buildChatSchema, promptDraftSchema, updateChatSchema } from '../validators/rangerAi.validator.js';

const router = Router();

router.post('/chat', validate(buildChatSchema), rangerAi.buildChat);
router.post('/prompt', validate(promptDraftSchema), rangerAi.draftPrompt);
router.post('/update', validate(updateChatSchema), rangerAi.updateChat);

export default router;
