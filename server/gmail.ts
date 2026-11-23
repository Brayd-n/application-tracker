import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUser } from './auth.ts';

// Optional "Connect Gmail": reads only message headers (From, Subject, date) with the gmail.metadata scope,
// keeps only messages that match one of the user's applications, and never reads message bodies.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const OAUTH_COOKIE = '__Host-gmail-oauth';
const cookieOpts = { path: '/', httpOnly: true, secure: true, sameSite: 'lax' as const };
const FIRST_SCAN_DAYS = 30;
const MAX_MESSAGES_PER_SCAN = 200;

export type GmailConfig = { origin: string; googleClientId: string; googleClientSecret: string; tokenKey?: Buffer };

// ── Token encryption (AES-256-GCM: 12-byte IV | 16-byte tag | ciphertext) ──
export function encrypt(key: Buffer, text: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
export function decrypt(key: Buffer, blob: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}

// ── Matching an email to an application ──
const LEGAL = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'group', 'the', 'and', 'plc', 'gmbh', 'lp', 'llp', 'pllc', 'holdings', 'international']);
const FREE_MAIL = new Set(['gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'yahoo', 'icloud', 'me', 'aol', 'proton', 'protonmail']);
// What may follow a company name in its domain: acmecorp.com, acmecareers.com, but not acmeticketsplus.com.
const DOMAIN_SUFFIXES = ['', 'corp', 'inc', 'co', 'llc', 'group', 'hq', 'careers', 'jobs', 'usa', 'us', 'global', 'team', 'hr', 'talent', 'recruiting'];
const GENERIC_LABELS = new Set(['mail', 'email', 'e', 'careers', 'career', 'jobs', 'job', 'hr', 'talent', 'recruiting', 'notifications', 'notification', 'noreply', 'us', 'eu', 'em', 'info', 'news', 'www', 'reply', 'smtp', 'bounce']);

const words = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter((w) => w && !LEGAL.has(w));

export function parseFrom(header: string): { name: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(header);
  return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: '', email: header.trim().toLowerCase() };
}

export function matchEmail(from: { name: string; email: string }, subject: string, apps: { id: string; company: string }[]): string | null {
  const domain = from.email.split('@')[1] ?? '';
  const labels = domain.split('.').slice(0, -1).filter((l) => !GENERIC_LABELS.has(l));
  const freeMail = labels.some((l) => FREE_MAIL.has(l));
  const text = ` ${words(`${from.name} ${subject}`).join(' ')} `;
  let best: { id: string; len: number } | null = null;
  for (const app of apps) {
    const w = words(app.company);
    const key = w.join('');
    if (key.length < 3) continue;
    const keys = [key, w.join('and')]; // "Harbor & Pine" → harborpine, harborandpine
    // 1) Sender domain is the company's: careers@northwindanalytics.com ↔ "Northwind Analytics"
    const byDomain =
      !freeMail &&
      labels.some((l) => keys.some((k) => DOMAIN_SUFFIXES.some((suf) => l === k + suf)) || (w[0].length >= 5 && l.startsWith(w[0]) && key.startsWith(l)));
    // 2) Company name appears as whole words in the sender name or subject (covers ATS mail like greenhouse-mail.io)
    const byText = key.length >= 4 && text.includes(` ${w.join(' ')} `);
    if ((byDomain || byText) && (!best || key.length > best.len)) best = { id: app.id, len: key.length };
  }
  return best?.id ?? null;
}

// ── Google API calls ──
async function googleJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Google API ${res.status}: ${body.error?.message ?? body.error ?? ''}`), { status: res.status, code: body.error });
  return body;
}

async function accessToken(cfg: GmailConfig, refreshToken: string): Promise<string> {
  const body = await googleJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  return body.access_token;
}

async function revoke(token: string) {
  await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

export async function disconnectGmail(pool: pg.Pool, cfg: GmailConfig, userId: string) {
  const { rows } = await pool.query('DELETE FROM gmail_accounts WHERE user_id = $1 RETURNING refresh_token_enc', [userId]);
  await pool.query('DELETE FROM email_matches WHERE user_id = $1', [userId]);
  if (rows[0] && cfg.tokenKey) await revoke(decrypt(cfg.tokenKey, rows[0].refresh_token_enc));
}

// Checks one user's inbox for new messages and records the ones that match an application.
export async function scanUser(pool: pg.Pool, cfg: GmailConfig, userId: string): Promise<number> {
  if (!cfg.tokenKey) return 0;
  const { rows } = await pool.query('SELECT g.refresh_token_enc, g.last_internal_date, u.email FROM gmail_accounts g JOIN users u ON u.id = g.user_id WHERE g.user_id = $1', [userId]);
  if (!rows[0]) return 0;
  let token: string;
  try {
    token = await accessToken(cfg, decrypt(cfg.tokenKey, rows[0].refresh_token_enc));
  } catch (e: any) {
    // The user revoked access in their Google account (or the token expired): forget the connection.
    if (e.code === 'invalid_grant') await disconnectGmail(pool, cfg, userId);
    throw e;
  }
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const since = Math.max(Number(rows[0].last_internal_date), Date.now() - FIRST_SCAN_DAYS * 86400_000);
  const apps = (await pool.query('SELECT id, company FROM applications WHERE user_id = $1 ORDER BY updated_at DESC', [userId])).rows;

  let newest = Number(rows[0].last_internal_date);
  let found = 0;
  let seen = 0;
  let pageToken = '';
  scan: do {
    const list = await googleJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`, auth);
    for (const { id } of list.messages ?? []) {
      if (++seen > MAX_MESSAGES_PER_SCAN) break scan;
      const msg = await googleJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, auth);
      const date = Number(msg.internalDate);
      if (date <= since) break scan; // the list is newest first; everything after this was already checked
      newest = Math.max(newest, date);
      const header = (n: string) => msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === n.toLowerCase())?.value ?? '';
      const from = parseFrom(header('From'));
      if (from.email === rows[0].email) continue;
      const subject = header('Subject').slice(0, 300);
      const appId = matchEmail(from, subject, apps);
      if (!appId) continue;
      const r = await pool.query(
        `INSERT INTO email_matches (user_id, application_id, gmail_id, from_name, from_email, subject, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0)) ON CONFLICT (user_id, gmail_id) DO NOTHING`,
        [userId, appId, id, from.name.slice(0, 200), from.email.slice(0, 320), subject, date],
      );
      found += r.rowCount ?? 0;
    }
    pageToken = list.nextPageToken ?? '';
  } while (pageToken);

  await pool.query('UPDATE gmail_accounts SET last_checked_at = now(), last_internal_date = $2 WHERE user_id = $1', [userId, Math.max(newest, since)]);
  return found;
}

export async function scanAll(pool: pg.Pool, cfg: GmailConfig, log: { warn: (o: object, m: string) => void }) {
  const { rows } = await pool.query('SELECT user_id FROM gmail_accounts');
  for (const { user_id } of rows) {
    await scanUser(pool, cfg, user_id).catch((e) => log.warn({ err: e.message }, 'gmail scan failed'));
  }
}

// ── Routes ──
export function gmailAuthRoutes(app: FastifyInstance, pool: pg.Pool, cfg: GmailConfig) {
  const redirectUri = `${cfg.origin}/auth/gmail/callback`;
  const b64url = (b: Buffer) => b.toString('base64url');
  const limit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.get('/auth/gmail', { config: limit, preHandler: (req, reply) => requireUser(pool, req, reply) }, async (req, reply) => {
    if (!cfg.tokenKey) return reply.redirect('/#/account?gmail=unavailable');
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state, verifier }), { ...cookieOpts, maxAge: 600 });
    const params = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: `openid ${GMAIL_SCOPE}`,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      login_hint: req.user.email,
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/gmail/callback',
    { config: limit, preHandler: (req, reply) => requireUser(pool, req, reply) },
    async (req, reply) => {
      let saved: { state?: string; verifier?: string } = {};
      try {
        saved = JSON.parse(req.cookies[OAUTH_COOKIE] ?? '{}');
      } catch {}
      reply.clearCookie(OAUTH_COOKIE, cookieOpts);
      const { code, state } = req.query;
      if (!cfg.tokenKey || !code || !state || state !== saved.state) return reply.redirect('/#/account?gmail=failed');

      let tokens: { refresh_token?: string; scope?: string; id_token?: string };
      try {
        tokens = await googleJson('https://oauth2.googleapis.com/token', {
          method: 'POST',
          body: new URLSearchParams({ code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: saved.verifier ?? '' }),
        });
      } catch (e) {
        req.log.warn({ err: (e as Error).message }, 'gmail: token exchange failed');
        return reply.redirect('/#/account?gmail=failed');
      }
      // The user can untick the Gmail box on Google's consent screen.
      if (!tokens.refresh_token || !tokens.scope?.split(' ').includes(GMAIL_SCOPE)) {
        if (tokens.refresh_token) await revoke(tokens.refresh_token);
        return reply.redirect('/#/account?gmail=denied');
      }
      // Only the mailbox of the Google account the user signed in with can be connected.
      const claims = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1] ?? '', 'base64url').toString() || '{}');
      const { rows } = await pool.query('SELECT google_sub FROM users WHERE id = $1', [req.user.id]);
      if (claims.aud !== cfg.googleClientId || claims.sub !== rows[0]?.google_sub) {
        await revoke(tokens.refresh_token);
        return reply.redirect('/#/account?gmail=wrong-account');
      }
      await pool.query(
        `INSERT INTO gmail_accounts (user_id, refresh_token_enc) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc, connected_at = now()`,
        [req.user.id, encrypt(cfg.tokenKey, tokens.refresh_token)],
      );
      scanUser(pool, cfg, req.user.id).catch((e) => req.log.warn({ err: e.message }, 'gmail: first scan failed'));
      return reply.redirect('/#/account?gmail=connected');
    },
  );
}

export function gmailApiRoutes(api: FastifyInstance, pool: pg.Pool, cfg: GmailConfig) {
  api.get('/gmail', async (req) => {
    const { rows } = await pool.query('SELECT connected_at, last_checked_at FROM gmail_accounts WHERE user_id = $1', [req.user.id]);
    return { available: !!cfg.tokenKey, connected: !!rows[0], ...rows[0] };
  });

  api.post('/gmail/check', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (req) => ({ found: await scanUser(pool, cfg, req.user.id) }));

  api.delete('/gmail', async (req) => {
    await disconnectGmail(pool, cfg, req.user.id);
    return { ok: true };
  });

  api.get('/notifications', async (req) => {
    const { rows } = await pool.query(
      `SELECT m.id, m.application_id, a.company, m.gmail_id, m.from_name, m.from_email, m.subject, m.received_at, m.read
       FROM email_matches m JOIN applications a ON a.id = m.application_id
       WHERE m.user_id = $1 ORDER BY m.received_at DESC LIMIT 50`,
      [req.user.id],
    );
    return rows;
  });

  api.post('/notifications/read', async (req) => {
    await pool.query('UPDATE email_matches SET read = true WHERE user_id = $1 AND NOT read', [req.user.id]);
    return { ok: true };
  });
}
