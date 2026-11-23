import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { authRoutes, requireUser, type AuthConfig } from './auth.ts';
import { AutofillError, autofill } from './autofill.ts';
import { MAX_UPLOAD_BYTES, UploadError, safeFilename, sanitize } from './uploads.ts';

export type Config = AuthConfig & { uploadDir: string; webDir?: string; userQuotaBytes?: number };

const WORK_TYPES = ['on_site', 'hybrid', 'remote'];
const WORKLOADS = ['full_time', 'part_time', 'contract', 'internship'];
const STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'hired', 'rejected', 'withdrawn'];
const KINDS = ['phone_screen', 'interview', 'technical', 'follow_up', 'offer', 'other'];
const OUTCOMES = ['passed', 'denied', 'abandoned', 'in_progress', 'technical_assignment', 'hired'];

const text = (max: number) => ({ type: 'string', maxLength: max });
const optEnum = (values: string[]) => ({ type: ['string', 'null'], enum: [...values, null] });
const optDate = { type: ['string', 'null'], format: 'date' };

const applicationBody = {
  type: 'object',
  additionalProperties: false,
  required: ['company', 'position'],
  properties: {
    company: { type: 'string', minLength: 1, maxLength: 200 },
    position: { type: 'string', minLength: 1, maxLength: 200 },
    work_type: optEnum(WORK_TYPES),
    location: text(200),
    // Only http(s) links, so a stored link can never become a javascript: URL.
    link: { type: 'string', maxLength: 2000, pattern: '^(https?://\\S+)?$' },
    description: text(100_000),
    pay: text(200),
    workload: optEnum(WORKLOADS),
    status: { type: 'string', enum: STATUSES },
    notes: text(20_000),
    applied_on: optDate,
    follow_up_on: optDate,
  },
};
const APP_COLS = Object.keys(applicationBody.properties);

const eventBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: KINDS },
    happened_on: optDate,
    with_whom: text(200),
    outcome: optEnum(OUTCOMES),
    notes: text(20_000),
  },
};
const EVENT_COLS = Object.keys(eventBody.properties);

const idParam = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] };

// CSV cells starting with these can run as formulas in Excel/Sheets, so they get a leading quote.
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildApp(pool: pg.Pool, cfg: Config) {
  // Caddy reaches the container through Docker's private bridge network; trust X-Forwarded-For only from there.
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: 'loopback,uniquelocal', bodyLimit: 1_048_576 });
  const quota = cfg.userQuotaBytes ?? 200 * 1024 * 1024;
  const fileOf = (userId: string, id: string) => path.join(cfg.uploadDir, userId, id);

  app.register(cookie);
  app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 } });

  // CSRF: session cookies are SameSite=Lax, and every state-changing request must also come from our own origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== cfg.origin) {
      return reply.code(403).send({ error: 'Cross-site request blocked.' });
    }
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AutofillError || err instanceof UploadError) return reply.code(400).send({ error: err.message });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(400).send({ error: 'Files can be at most 10 MB.' });
    if (err.validation) return reply.code(400).send({ error: `Invalid input: ${err.message}` });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong.' });
  });

  authRoutes(app, pool, cfg);
  app.get('/healthz', async () => ({ ok: true }));

  // Everything under /api needs a signed-in user, and every query below is scoped to req.user.id.
  app.register(async (api) => {
    api.addHook('preHandler', (req, reply) => requireUser(pool, req, reply));

    api.get('/me', async (req) => req.user);

    api.get('/applications', async (req) => {
      const { rows } = await pool.query(
        `SELECT a.id, a.company, a.position, a.work_type, a.location, a.link, a.pay, a.workload, a.status,
                a.notes, a.applied_on, a.follow_up_on, a.updated_at,
                (SELECT count(*)::int FROM events e WHERE e.application_id = a.id) AS event_count,
                (SELECT e.outcome FROM events e WHERE e.application_id = a.id AND e.outcome IS NOT NULL
                  ORDER BY e.happened_on DESC NULLS LAST, e.created_at DESC LIMIT 1) AS last_outcome,
                (SELECT json_build_object('date', e.happened_on, 'kind', e.kind) FROM events e
                  WHERE e.application_id = a.id AND e.happened_on >= current_date - 1
                  ORDER BY e.happened_on LIMIT 1) AS next_event
         FROM applications a WHERE a.user_id = $1 ORDER BY a.created_at DESC`,
        [req.user.id],
      );
      return rows;
    });

    api.post('/applications', { schema: { body: applicationBody } }, async (req, reply) => {
      const body = req.body as Record<string, unknown>;
      const cols = APP_COLS.filter((c) => body[c] !== undefined);
      const { rows } = await pool.query(
        `INSERT INTO applications (user_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [req.user.id, ...cols.map((c) => body[c])],
      );
      return reply.code(201).send(rows[0]);
    });

    api.get('/applications/:id', { schema: { params: idParam } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { rows } = await pool.query('SELECT * FROM applications WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (!rows[0]) return reply.code(404).send({ error: 'Not found.' });
      const events = await pool.query(
        `SELECT e.id, e.kind, e.happened_on, e.with_whom, e.outcome, e.notes,
                coalesce((SELECT json_agg(json_build_object('id', t.id, 'filename', t.filename, 'mime', t.mime, 'size', t.size) ORDER BY t.created_at)
                          FROM attachments t WHERE t.event_id = e.id), '[]') AS attachments
         FROM events e WHERE e.application_id = $1 AND e.user_id = $2
         ORDER BY e.happened_on NULLS LAST, e.created_at`,
        [id, req.user.id],
      );
      const { user_id, ...application } = rows[0];
      return { ...application, events: events.rows };
    });

    api.put('/applications/:id', { schema: { params: idParam, body: applicationBody } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      const cols = APP_COLS.filter((c) => body[c] !== undefined);
      const { rowCount } = await pool.query(
        `UPDATE applications SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2`,
        [id, req.user.id, ...cols.map((c) => body[c])],
      );
      return rowCount ? { ok: true } : reply.code(404).send({ error: 'Not found.' });
    });

    api.delete('/applications/:id', { schema: { params: idParam } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const files = await pool.query(
        'SELECT t.id FROM attachments t JOIN events e ON e.id = t.event_id WHERE e.application_id = $1 AND t.user_id = $2',
        [id, req.user.id],
      );
      const { rowCount } = await pool.query('DELETE FROM applications WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      await Promise.all(files.rows.map((f) => unlink(fileOf(req.user.id, f.id)).catch(() => {})));
      return rowCount ? { ok: true } : reply.code(404).send({ error: 'Not found.' });
    });

    api.post('/applications/:id/events', { schema: { params: idParam, body: eventBody } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      const cols = EVENT_COLS.filter((c) => body[c] !== undefined);
      // INSERT ... SELECT only inserts when the application belongs to this user.
      const { rows } = await pool.query(
        `INSERT INTO events (application_id, user_id${cols.map((c) => ', ' + c).join('')})
         SELECT id, user_id${cols.map((_, i) => `, $${i + 3}`).join('')} FROM applications WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, req.user.id, ...cols.map((c) => body[c])],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Not found.' });
      await pool.query('UPDATE applications SET updated_at = now() WHERE id = $1', [id]);
      return reply.code(201).send(rows[0]);
    });

    api.put('/events/:id', { schema: { params: idParam, body: eventBody } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      const cols = EVENT_COLS.filter((c) => body[c] !== undefined);
      if (!cols.length) return { ok: true };
      const { rowCount } = await pool.query(
        `UPDATE events SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} WHERE id = $1 AND user_id = $2`,
        [id, req.user.id, ...cols.map((c) => body[c])],
      );
      return rowCount ? { ok: true } : reply.code(404).send({ error: 'Not found.' });
    });

    api.delete('/events/:id', { schema: { params: idParam } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const files = await pool.query('SELECT id FROM attachments WHERE event_id = $1 AND user_id = $2', [id, req.user.id]);
      const { rowCount } = await pool.query('DELETE FROM events WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      await Promise.all(files.rows.map((f) => unlink(fileOf(req.user.id, f.id)).catch(() => {})));
      return rowCount ? { ok: true } : reply.code(404).send({ error: 'Not found.' });
    });

    api.post('/events/:id/attachments', { schema: { params: idParam }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const owned = await pool.query(
        'SELECT (SELECT coalesce(sum(size), 0)::bigint FROM attachments WHERE user_id = $2) AS used FROM events WHERE id = $1 AND user_id = $2',
        [id, req.user.id],
      );
      if (!owned.rows[0]) return reply.code(404).send({ error: 'Not found.' });
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'No file was sent.' });
      const { data, mime } = await sanitize(await part.toBuffer());
      if (Number(owned.rows[0].used) + data.length > quota) return reply.code(400).send({ error: 'Storage limit reached (200 MB). Delete some files first.' });

      const { rows } = await pool.query(
        'INSERT INTO attachments (event_id, user_id, filename, mime, size) VALUES ($1, $2, $3, $4, $5) RETURNING id, filename, mime, size',
        [id, req.user.id, safeFilename(part.filename), mime, data.length],
      );
      try {
        await mkdir(path.join(cfg.uploadDir, req.user.id), { recursive: true, mode: 0o700 });
        await writeFile(fileOf(req.user.id, rows[0].id), data, { mode: 0o600 });
      } catch (e) {
        await pool.query('DELETE FROM attachments WHERE id = $1', [rows[0].id]);
        throw e;
      }
      return reply.code(201).send(rows[0]);
    });

    api.get('/attachments/:id', { schema: { params: idParam } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { rows } = await pool.query('SELECT filename, mime FROM attachments WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (!rows[0]) return reply.code(404).send({ error: 'Not found.' });
      const { filename, mime } = rows[0];
      const disposition = mime.startsWith('image/') && !('download' in (req.query as object)) ? 'inline' : 'attachment';
      return reply
        .header('Content-Type', mime)
        .header('Content-Disposition', `${disposition}; filename="file"; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(await readFile(fileOf(req.user.id, id)));
    });

    api.delete('/attachments/:id', { schema: { params: idParam } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { rowCount } = await pool.query('DELETE FROM attachments WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (!rowCount) return reply.code(404).send({ error: 'Not found.' });
      await unlink(fileOf(req.user.id, id)).catch(() => {});
      return { ok: true };
    });

    api.post(
      '/autofill',
      {
        schema: { body: { type: 'object', required: ['url'], properties: { url: { type: 'string', maxLength: 2000 } } } },
        config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
      },
      async (req) => autofill((req.body as { url: string }).url),
    );

    api.get('/export.csv', async (req, reply) => {
      const { rows } = await pool.query(
        `SELECT a.*, coalesce((SELECT string_agg(concat_ws(' ', e.happened_on, e.kind, e.outcome, nullif(e.with_whom, '')), '; ' ORDER BY e.happened_on NULLS LAST)
                               FROM events e WHERE e.application_id = a.id), '') AS interviews
         FROM applications a WHERE a.user_id = $1 ORDER BY a.created_at`,
        [req.user.id],
      );
      const cols = ['company', 'position', 'work_type', 'location', 'link', 'pay', 'workload', 'status', 'applied_on', 'follow_up_on', 'interviews', 'notes', 'description'];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
      return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="applications.csv"').send(csv);
    });

    api.delete('/account', async (req, reply) => {
      await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]); // cascades to sessions, applications, events, attachments
      await rm(path.join(cfg.uploadDir, req.user.id), { recursive: true, force: true });
      reply.clearCookie('__Host-session', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
      return { ok: true };
    });
  }, { prefix: '/api' });

  // The built React app. /privacy and /terms are plain HTML pages so Google's reviewers can read them without JS.
  if (cfg.webDir && existsSync(cfg.webDir)) {
    app.register(fastifyStatic, { root: cfg.webDir, wildcard: false });
    app.get('/privacy', (_req, reply) => reply.sendFile('privacy.html'));
    app.get('/terms', (_req, reply) => reply.sendFile('terms.html'));
    app.setNotFoundHandler((req, reply) =>
      req.method === 'GET' && !req.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found.' }),
    );
  }
  return app;
}
