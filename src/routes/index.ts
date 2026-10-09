import { Router } from 'express';
import authRoutes from './auth.routes.js';
import channelDetailsRoutes from './channelDetails.routes.js';
import discordRoutes from './discord.routes.js';
import healthRoutes from './health.routes.js';
import manifestRoutes from './manifest.routes.js';
import rangerAiRoutes from './rangerAi.routes.js';
import schedulerRoutes from './scheduler.routes.js';
import telegramRoutes from './telegram.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/channel-details', channelDetailsRoutes);
router.use('/manifest', manifestRoutes);
router.use('/ranger-ai', rangerAiRoutes);
router.use('/scheduler', schedulerRoutes);
router.use('/telegram', telegramRoutes);
router.use('/discord', discordRoutes);

export default router;
