import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';

export const SESSION_COOKIE = '__Host-session';
const OAUTH_COOKIE = '__Host-oauth';
const SESSION_DAYS = 30;

const hash = (token: string) => createHash('sha256').update(token).digest();
const b64url = (b: Buffer) => b.toString('base64url');

export async function createSession(pool: pg.Pool, userId: string): Promise<string> {
  const token = b64url(randomBytes(32));
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [hash(token), userId]);
  return token;
}

export async function userForToken(pool: pg.Pool, token: string | undefined): Promise<{ id: string; email: string; name: string } | null> {
  if (!token) return null;
  const { rows } = await pool.query(
    'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()',
    [hash(token)],
  );
  return rows[0] ?? null;
}

const cookieOpts = { path: '/', httpOnly: true, secure: true, sameSite: 'lax' as const };

export type AuthConfig = { origin: string; googleClientId: string; googleClientSecret: string };

// Google sign-in with the OpenID Connect authorization-code flow + PKCE, state and nonce.
// The ID token comes straight from Google's token endpoint over TLS (not through the browser),
// so per OIDC Core 3.1.3.7 its claims are checked without verifying the JWT signature.
export function authRoutes(app: FastifyInstance, pool: pg.Pool, cfg: AuthConfig) {
  const redirectUri = `${cfg.origin}/auth/google/callback`;
  const loginLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  app.get('/auth/google', { config: loginLimit }, async (_req, reply) => {
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state, nonce, verifier }), { ...cookieOpts, maxAge: 600 });
    const params = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>('/auth/google/callback', { config: loginLimit }, async (req, reply) => {
    let saved: { state?: string; nonce?: string; verifier?: string } = {};
    try {
      saved = JSON.parse(req.cookies[OAUTH_COOKIE] ?? '{}');
    } catch {}
    reply.clearCookie(OAUTH_COOKIE, cookieOpts);
    const { code, state } = req.query;
    if (!code || !state || !saved.state || state !== saved.state) {
      req.log.warn('sign-in: missing code or state mismatch');
      return reply.redirect('/?login=failed');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        code,
        client_id: cfg.googleClientId,
        client_secret: cfg.googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: saved.verifier ?? '',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      req.log.warn({ status: res.status, error: ((await res.json().catch(() => ({}))) as { error?: string }).error }, 'sign-in: token exchange failed');
      return reply.redirect('/?login=failed');
    }
    const { id_token } = (await res.json()) as { id_token?: string };
    const claims = JSON.parse(Buffer.from(String(id_token).split('.')[1] ?? '', 'base64url').toString() || '{}');
    const valid =
      ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) &&
      claims.aud === cfg.googleClientId &&
      claims.exp * 1000 > Date.now() &&
      claims.nonce === saved.nonce &&
      claims.email_verified === true &&
      typeof claims.sub === 'string';
    if (!valid) {
      req.log.warn('sign-in: ID token claims rejected');
      return reply.redirect('/?login=failed');
    }

    const { rows } = await pool.query(
      `INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name RETURNING id`,
      [claims.sub, claims.email, String(claims.name ?? '').slice(0, 200)],
    );
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    reply.setCookie(SESSION_COOKIE, await createSession(pool, rows[0].id), { ...cookieOpts, maxAge: SESSION_DAYS * 86400 });
    return reply.redirect('/');
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });
}

export async function requireUser(pool: pg.Pool, req: FastifyRequest, reply: FastifyReply) {
  const user = await userForToken(pool, req.cookies[SESSION_COOKIE]);
  if (!user) return reply.code(401).send({ error: 'Please sign in.' });
  req.user = user;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; name: string };
  }
}
