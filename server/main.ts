import { buildApp } from './app.ts';
import { createPool, migrate } from './db.ts';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
};

const pool = createPool();
await migrate(pool);
const app = buildApp(pool, {
  origin: env('APP_ORIGIN', 'http://localhost:3000'),
  googleClientId: env('GOOGLE_CLIENT_ID', ''),
  googleClientSecret: env('GOOGLE_CLIENT_SECRET', ''),
  uploadDir: env('UPLOAD_DIR', './data/uploads'),
  webDir: new URL('../dist/', import.meta.url).pathname,
});
await app.listen({ host: env('HOST', '127.0.0.1'), port: Number(env('PORT', '3000')) });
