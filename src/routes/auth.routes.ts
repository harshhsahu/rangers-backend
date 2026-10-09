import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import { validate } from '../middlewares/validate.js';
import { internalLoginSchema } from '../validators/auth.validator.js';

const router = Router();

router.post('/internal-login', validate(internalLoginSchema), auth.login);

export default router;
