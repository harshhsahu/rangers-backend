import { Router } from 'express';
import { getManifest } from '../controllers/manifest.controller.js';
import { validate } from '../middlewares/validate.js';
import { manifestSchema } from '../validators/manifest.validator.js';

const router = Router();

router.get('/', validate(manifestSchema), getManifest);

export default router;
