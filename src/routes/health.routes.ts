import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ success: true, status: 'ok', uptime: process.uptime() });
});

export default router;
