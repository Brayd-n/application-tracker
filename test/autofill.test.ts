import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, fetchJobPage, greenhouseApiUrl, htmlToText, isPublicAddress, parseGreenhouseJob, parseJobPage } from '../server/autofill.ts';

test('JSON-LD JobPosting (Greenhouse style, entity-encoded HTML description)', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Software Engineer &amp; Analyst',
    hiringOrganization: { '@type': 'Organization', name: 'Acme Corp' },
    jobLocation: [{ address: { addressLocality: 'Reston', addressRegion: 'VA', addressCountry: 'US' } }],
    employmentType: 'FULL_TIME',
    baseSalary: { currency: 'USD', value: { minValue: 55000, maxValue: 65000, unitText: 'YEAR' } },
    description: '&lt;p&gt;Build things.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Java&lt;/li&gt;&lt;li&gt;SQL &amp;amp; APIs&lt;/li&gt;&lt;/ul&gt;',
  })}</script></head></html>`;
  assert.deepEqual(parseJobPage(html), {
    position: 'Software Engineer & Analyst',
    company: 'Acme Corp',
    location: 'Reston, VA, US',
    pay: '$55,000–$65,000 / year',
    description: 'Build things.\n\n• Java\n• SQL & APIs',
    workload: 'full_time',
  });
});

test('JobPosting inside @graph, remote job, hourly pay', () => {
  const html = `<script type='application/ld+json'>{"@graph":[{"@type":"WebPage"},{"@type":["JobPosting"],"title":"Analyst",
    "hiringOrganization":"Olio","jobLocationType":"TELECOMMUTE","employmentType":["PART_TIME"],
    "baseSalary":{"currency":"USD","value":{"value":25,"unitText":"HOUR"}}}]}</script>`;
  const f = parseJobPage(html);
  assert.equal(f.position, 'Analyst');
  assert.equal(f.company, 'Olio');
  assert.equal(f.work_type, 'remote');
  assert.equal(f.location, 'Remote');
  assert.equal(f.workload, 'part_time');
  assert.equal(f.pay, '$25 / hour');
});

test('broken JSON-LD is skipped and OpenGraph is used', () => {
  const html = `<script type="application/ld+json">{not json</script>
    <meta property="og:title" content="Marketing Coordinator">
    <meta content='Lisa &amp; Leroy' property='og:site_name'>
    <meta name="description" content="Plan &lt;b&gt;events&lt;/b&gt;.">`;
  assert.deepEqual(parseJobPage(html), { position: 'Marketing Coordinator', company: 'Lisa & Leroy', description: 'Plan events.' });
});

test('page with nothing useful returns no fields', () => {
  assert.deepEqual(parseJobPage('<html><body>hi</body></html>'), {});
});

test('htmlToText drops scripts and decodes numeric entities', () => {
  assert.equal(htmlToText('<script>alert(1)</script><p>caf&#233; &#x2014; ok</p>'), 'café — ok');
});

test('private, loopback, link-local and metadata addresses are not public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});

test('checkUrl rejects bad schemes, ports, credentials, private IP literals and no-scrape sites', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com', 'http://example.com:8080/', 'https://user:pw@example.com/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/',
    'https://www.linkedin.com/jobs/view/1', 'https://indeed.com/viewjob?jk=1', 'not a url']) {
    assert.throws(() => checkUrl(url), url);
  }
  assert.equal(checkUrl('https://boards.greenhouse.io/acme/jobs/1').hostname, 'boards.greenhouse.io');
});

test('hostnames that resolve to private addresses are refused at connect time', async () => {
  await assert.rejects(fetchJobPage('http://localhost/'), /not allowed/);
});

test('Greenhouse job pages are read through its public Job Board API', () => {
  assert.equal(greenhouseApiUrl('https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x'), 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123');
  assert.equal(greenhouseApiUrl('https://boards.greenhouse.io/acme/jobs/123'), 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123');
  assert.equal(greenhouseApiUrl('https://acme.com/jobs/123'), null);
  const json = JSON.stringify({ title: 'Engineer', company_name: 'Acme', location: { name: 'Remote - US' }, content: '&lt;p&gt;Hello&lt;/p&gt;' });
  assert.deepEqual(parseGreenhouseJob(json), { position: 'Engineer', company: 'Acme', location: 'Remote - US', description: 'Hello', work_type: 'remote' });
});
