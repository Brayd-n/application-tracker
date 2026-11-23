import { buildApp } from './app.ts';
import { createPool, migrate } from './db.ts';
import { scanAll } from './gmail.ts';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
};

const pool = createPool();
await migrate(pool);
// 32-byte hex key for encrypting Gmail refresh tokens. Without it, "Connect Gmail" is turned off.
const tokenKey = process.env.TOKEN_KEY ? Buffer.from(process.env.TOKEN_KEY, 'hex') : undefined;
if (tokenKey && tokenKey.length !== 32) throw new Error('TOKEN_KEY must be 64 hex characters');
const cfg = {
  origin: env('APP_ORIGIN', 'http://localhost:3000'),
  googleClientId: env('GOOGLE_CLIENT_ID', ''),
  googleClientSecret: env('GOOGLE_CLIENT_SECRET', ''),
  uploadDir: env('UPLOAD_DIR', './data/uploads'),
  webDir: new URL('../dist/', import.meta.url).pathname,
  tokenKey,
};
const app = buildApp(pool, cfg);
await app.listen({ host: env('HOST', '127.0.0.1'), port: Number(env('PORT', '3000')) });

// Check connected Gmail inboxes every 10 minutes.
setInterval(() => scanAll(pool, cfg, app.log), 10 * 60_000).unref();
