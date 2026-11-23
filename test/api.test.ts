// API tests against a real PostgreSQL (PG* env vars). They wipe the database's public schema.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../server/app.ts';
import { createSession } from '../server/auth.ts';
import { createPool, migrate } from '../server/db.ts';

process.env.NODE_ENV = 'test';
const ORIGIN = 'https://tracker.test';
const pool = createPool();
let app: ReturnType<typeof buildApp>;
let uploadDir: string;
const users: Record<string, { id: string; cookie: string }> = {};

async function makeUser(name: string) {
  const { rows } = await pool.query("INSERT INTO users (google_sub, email, name) VALUES ($1, $1 || '@example.com', $1) RETURNING id", [name]);
  users[name] = { id: rows[0].id, cookie: `__Host-session=${await createSession(pool, rows[0].id)}` };
}

const as = (user: string | null, method: string, url: string, payload?: object | string | Buffer, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as any,
    url,
    payload,
    headers: { origin: ORIGIN, ...(user ? { cookie: users[user].cookie } : {}), ...headers },
  });

function multipart(filename: string, data: Buffer) {
  const boundary = 'testboundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(pool);
  uploadDir = await mkdtemp(path.join(tmpdir(), 'tracker-uploads-'));
  app = buildApp(pool, { origin: ORIGIN, googleClientId: 'id', googleClientSecret: 'secret', uploadDir });
  await makeUser('alice');
  await makeUser('bob');
});
after(async () => {
  await app.close();
  await pool.end();
});

test("users can never see or change each other's data or files", async () => {
  // Alice creates an application, an interview, and an attachment.
  const created = await as('alice', 'POST', '/api/applications', { company: 'Polaris', position: 'Media Associate', status: 'interviewing', pay: '$55,000' });
  assert.equal(created.statusCode, 201);
  const appId = created.json().id;
  const ev = await as('alice', 'POST', `/api/applications/${appId}/events`, { kind: 'interview', outcome: 'passed', happened_on: '2026-04-16' });
  assert.equal(ev.statusCode, 201);
  const eventId = ev.json().id;
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } }).png().toBuffer();
  const mp = multipart('notes.png', png);
  const up = await as('alice', 'POST', `/api/events/${eventId}/attachments`, mp.body, mp.headers);
  assert.equal(up.statusCode, 201, up.body);
  const fileId = up.json().id;

  // Alice sees all of it.
  assert.equal((await as('alice', 'GET', `/api/applications/${appId}`)).json().events[0].attachments[0].id, fileId);
  assert.equal((await as('alice', 'GET', `/api/attachments/${fileId}`)).statusCode, 200);

  // Bob sees none of it and can't change any of it.
  assert.deepEqual((await as('bob', 'GET', '/api/applications')).json(), []);
  const denied = [
    await as('bob', 'GET', `/api/applications/${appId}`),
    await as('bob', 'PUT', `/api/applications/${appId}`, { company: 'x', position: 'y' }),
    await as('bob', 'POST', `/api/applications/${appId}/events`, { kind: 'interview' }),
    await as('bob', 'PUT', `/api/events/${eventId}`, { notes: 'x' }),
    await as('bob', 'POST', `/api/events/${eventId}/attachments`, mp.body, mp.headers),
    await as('bob', 'GET', `/api/attachments/${fileId}`),
    await as('bob', 'DELETE', `/api/attachments/${fileId}`),
    await as('bob', 'DELETE', `/api/events/${eventId}`),
    await as('bob', 'DELETE', `/api/applications/${appId}`),
  ];
  for (const r of denied) assert.equal(r.statusCode, 404, r.body);
  assert.ok(!(await as('bob', 'GET', '/api/export.csv')).body.includes('Polaris'));

  // Nothing of Alice's changed.
  const after = (await as('alice', 'GET', `/api/applications/${appId}`)).json();
  assert.equal(after.company, 'Polaris');
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].attachments.length, 1);

  // The database itself rejects an event that mixes Bob's user id with Alice's application.
  await assert.rejects(pool.query('INSERT INTO events (application_id, user_id) VALUES ($1, $2)', [appId, users.bob.id]), /foreign key/);
});

test('requests without a session or from another site are refused', async () => {
  assert.equal((await as(null, 'GET', '/api/applications')).statusCode, 401);
  assert.equal((await as('alice', 'GET', '/api/applications', undefined, { cookie: '__Host-session=forged' })).statusCode, 401);
  assert.equal((await as('alice', 'POST', '/api/applications', { company: 'a', position: 'b' }, { origin: 'https://evil.example' })).statusCode, 403);
  const noOrigin = await app.inject({ method: 'POST', url: '/api/applications', payload: { company: 'a', position: 'b' }, headers: { cookie: users.alice.cookie } });
  assert.equal(noOrigin.statusCode, 403);
});

test('input is validated', async () => {
  const bad = [
    { company: '', position: 'x' },
    { company: 'a', position: 'b', link: 'javascript:alert(1)' },
    { company: 'a', position: 'b', status: 'nope' },
    { company: 'a', position: 'b', applied_on: 'yesterday' },
  ];
  for (const body of bad) assert.equal((await as('alice', 'POST', '/api/applications', body)).statusCode, 400, JSON.stringify(body));
  assert.equal((await as('alice', 'GET', '/api/applications/not-a-uuid')).statusCode, 400);
});

test('uploads are checked by content', async () => {
  const appId = (await as('alice', 'POST', '/api/applications', { company: 'Olio', position: 'Marketer' })).json().id;
  const eventId = (await as('alice', 'POST', `/api/applications/${appId}/events`, {})).json().id;
  const fake = multipart('evil.png', Buffer.from('<html><script>alert(1)</script></html>'));
  const r = await as('alice', 'POST', `/api/events/${eventId}/attachments`, fake.body, fake.headers);
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Only PNG/);
});

test('CSV export neutralizes spreadsheet formulas', async () => {
  await as('alice', 'POST', '/api/applications', { company: '=HYPERLINK("http://evil")', position: 'Analyst, "Senior"' });
  const csv = (await as('alice', 'GET', '/api/export.csv')).body;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), csv);
  assert.ok(csv.includes('"Analyst, ""Senior"""'));
});

test('deleting an account removes all of its rows and files', async () => {
  const { id } = users.alice;
  assert.ok(existsSync(path.join(uploadDir, id)));
  assert.equal((await as('alice', 'DELETE', '/api/account')).statusCode, 200);
  assert.ok(!existsSync(path.join(uploadDir, id)));
  for (const table of ['users', 'sessions', 'applications', 'events', 'attachments']) {
    const col = table === 'users' ? 'id' : 'user_id';
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id])).rows[0].n, 0, table);
  }
  assert.equal((await as('alice', 'GET', '/api/me')).statusCode, 401);
  assert.deepEqual(await readdir(uploadDir), []);
});
