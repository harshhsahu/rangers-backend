import { Router } from 'express';
import * as viasocket from '../controllers/viasocket.controller.js';
import { validate } from '../middlewares/validate.js';
import {
  addAppToolSchema,
  appSearchSchema,
  authenticationsSchema,
  enableToolSchema,
  listAppToolsSchema,
  registerSchema,
  runToolSchema,
  tokenSchema,
  toolIdSchema,
  versionsSchema,
} from '../validators/viasocket.validator.js';

const router = Router();

router.get('/apps', validate(appSearchSchema), viasocket.searchApps);
router.get('/apps/:serviceId/versions', validate(versionsSchema), viasocket.listVersions);

router.post('/register', validate(registerSchema), viasocket.register);
router.post('/authentications', validate(authenticationsSchema), viasocket.findAuthentications);
router.post('/token', validate(tokenSchema), viasocket.signToken);

router
  .route('/app-tools')
  .get(validate(listAppToolsSchema), viasocket.listAppTools)
  .post(validate(addAppToolSchema), viasocket.addAppTool);
router.delete('/app-tools/:id', validate(toolIdSchema), viasocket.deleteAppTool);
// Called by GTWY, not the browser: authenticated by the row's run key, not a session.
router.post('/app-tools/:id/run', validate(runToolSchema), viasocket.runAppTool);

router.post('/tools', validate(enableToolSchema), viasocket.enableActionTool);
router.post('/run/:id', validate(runToolSchema), viasocket.runActionTool);

export default router;
