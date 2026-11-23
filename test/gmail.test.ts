import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, matchEmail, parseFrom } from '../server/gmail.ts';

const apps = [
  { id: 'nw', company: 'Northwind Analytics' },
  { id: 'hp', company: 'Harbor & Pine, LLC' },
  { id: 'acme', company: 'Acme' },
  { id: 'ibm', company: 'IBM' },
  { id: 'lisa', company: 'Lisa & Leroy' },
];
const m = (from: string, subject = '') => matchEmail(parseFrom(from), subject, apps);

test('parseFrom handles display names and bare addresses', () => {
  assert.deepEqual(parseFrom('"Dana Reyes" <Dana.Reyes@NorthwindAnalytics.com>'), { name: 'Dana Reyes', email: 'dana.reyes@northwindanalytics.com' });
  assert.deepEqual(parseFrom('jobs@acme.com'), { name: '', email: 'jobs@acme.com' });
});

test('matches by company email domain', () => {
  assert.equal(m('Dana <dana@northwindanalytics.com>'), 'nw');
  assert.equal(m('careers@mail.harborandpine.com'), 'hp');
  assert.equal(m('Recruiting <talent@acme.io>'), 'acme');
  assert.equal(m('hr@acmecorp.com'), 'acme');
  assert.equal(m('jobs@northwind.com'), 'nw'); // first word of the name is enough when it's long
  assert.equal(m('info@north.com'), null);
});

test('matches recruiting-system mail by company name in the sender or subject', () => {
  assert.equal(m('Northwind Analytics Recruiting <no-reply@us.greenhouse-mail.io>'), 'nw');
  assert.equal(m('no-reply@myworkday.com', 'Thank you for applying to Harbor & Pine'), 'hp');
  assert.equal(m('noreply@lever.co', 'Your application to Lisa & Leroy'), 'lisa');
});

test('does not match unrelated mail', () => {
  assert.equal(m('newsletter@medium.com', 'Top stories for you'), null);
  assert.equal(m('friend@gmail.com', 'Lunch?'), null);
  assert.equal(m('deals@acmeticketsplus.com', 'Concert tickets'), null); // "acme" prefix only counts with a short label
  assert.equal(m('someone@gmail.com', 'Have you seen this?'), null); // free-mail domain never matches by domain
  assert.equal(m('news@example.com', 'Northwind is a word in this subject'), null); // needs the full company name
  assert.equal(m('ibmfan@example.com', 'I like IBM'), null); // names shorter than 4 letters only match by domain
});

test('prefers the longer, more specific company name', () => {
  const two = [{ id: 'short', company: 'Acme' }, { id: 'long', company: 'Acme Robotics' }];
  assert.equal(matchEmail(parseFrom('jobs@acmerobotics.com'), '', two), 'long');
});

test('refresh tokens round-trip through AES-GCM, and tampering is detected', () => {
  const key = randomBytes(32);
  const blob = encrypt(key, '1//refresh-token');
  assert.equal(decrypt(key, blob), '1//refresh-token');
  assert.ok(!blob.includes(Buffer.from('refresh-token')));
  blob[blob.length - 1] ^= 1;
  assert.throws(() => decrypt(key, blob));
  assert.throws(() => decrypt(randomBytes(32), encrypt(key, 'x')));
});
