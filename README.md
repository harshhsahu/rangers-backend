# rangers-backend

Node.js + TypeScript + Express API.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Scripts

- `npm run dev` – start with hot reload (tsx)
- `npm run build` – compile to `dist/`
- `npm start` – run compiled build
- `npm run typecheck` – type-check without emitting

## Structure

```
src/
  config/        env config
  middlewares/   error handling etc.
  routes/        route modules, mounted under /api
  app.ts         express app setup
  index.ts       server entry
```

Health check: `GET /api/health`
