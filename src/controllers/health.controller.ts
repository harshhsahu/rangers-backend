import type { Request, Response } from 'express';

export function getHealth(_req: Request, res: Response) {
  res.json({ success: true, status: 'ok', uptime: process.uptime() });
}
