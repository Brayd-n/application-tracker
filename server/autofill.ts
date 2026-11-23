import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

export class AutofillError extends Error {}

export type JobFields = {
  company?: string;
  position?: string;
  location?: string;
  pay?: string;
  description?: string;
  work_type?: 'on_site' | 'hybrid' | 'remote';
  workload?: 'full_time' | 'part_time' | 'contract' | 'internship';
};

// Sites whose terms forbid automated access. Users paste the description for these instead.
const NO_FETCH = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com'];
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8000;

// ── SSRF protection ──
// Every address a hostname resolves to must be public. The check runs inside the socket's DNS lookup,
// so the address that is checked is the address that is connected to (no DNS-rebinding gap).
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList(); // separate lists: Node matches IPv4 addresses against IPv4-mapped IPv6 rules
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked6.addSubnet(ip, bits, 'ipv6');

export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]);
  if (net.isIPv4(ip)) return !blocked4.check(ip, 'ipv4');
  return net.isIPv6(ip) && !blocked6.check(ip, 'ipv6');
}

const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new AutofillError('That address is not allowed.'), '', 0);
    }
    if (options.all) (callback as any)(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AutofillError('That is not a valid link.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AutofillError('Only http and https links work.');
  if (url.username || url.password) throw new AutofillError('Links with a username or password are not allowed.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new AutofillError('Only standard web ports are allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // IP literals skip DNS lookup entirely, so check them here.
  if (net.isIP(host) && !isPublicAddress(host)) throw new AutofillError('That address is not allowed.');
  if (NO_FETCH.some((d) => host === d || host.endsWith('.' + d))) {
    throw new AutofillError(`${host} doesn't allow automated access. Paste the job description instead.`);
  }
  return url;
}

function getOnce(url: URL, signal: AbortSignal): Promise<{ status: number; location?: string; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      lookup: safeLookup,
      agent: false,
      signal,
      headers: { 'User-Agent': 'ApplicationTrackerBot/1.0 (+https://applicationtracker.tech)', Accept: 'text/html,application/xhtml+xml,application/json' },
    });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, location: res.headers.location, type: '', body: '' });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy();
          reject(new AutofillError('That page is too large.'));
        } else chunks.push(c);
      });
      res.on('end', () => resolve({ status, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', (e) => reject(e instanceof AutofillError ? e : new AutofillError("Couldn't load that page.")));
    req.end();
  });
}

export async function fetchJobPage(raw: string, want: 'html' | 'json' = 'html'): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = checkUrl(raw);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await getOnce(url, signal);
    if (res.location) {
      url = checkUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status !== 200) throw new AutofillError(`The page answered with status ${res.status}.`);
    if (!new RegExp(want, 'i').test(res.type)) throw new AutofillError("That link isn't a web page.");
    return res.body;
  }
  throw new AutofillError('Too many redirects.');
}

// ── Parsing ──
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', hellip: '…' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  // Job boards often entity-encode the HTML inside JSON-LD, so decode once before removing tags.
  const text = decodeEntities(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|ul|ol|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 50_000);
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function findJobPosting(node: any): any {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findJobPosting(n);
      if (found) return found;
    }
    return null;
  }
  const type = node['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node;
  return findJobPosting(node['@graph']);
}

function formatPay(salary: any): string {
  if (!salary || typeof salary !== 'object') return str(salary);
  const v = salary.value && typeof salary.value === 'object' ? salary.value : salary;
  const cur = str(salary.currency || v.currency);
  const sym = cur === 'USD' || cur === '' ? '$' : cur + ' ';
  const n = (x: unknown) => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && !isNaN(+x)) ? sym + Number(x).toLocaleString('en-US') : '');
  const min = n(v.minValue), max = n(v.maxValue), single = n(typeof v.value === 'object' ? '' : v.value);
  const amount = min && max ? `${min}–${max}` : min || max || single;
  const unit = str(v.unitText).toLowerCase();
  return amount && unit ? `${amount} / ${unit}` : amount;
}

function formatLocation(loc: any): string {
  const parts = (Array.isArray(loc) ? loc : [loc]).map((l) => {
    const a = l?.address ?? l;
    if (typeof a === 'string') return a.trim();
    const country = typeof a?.addressCountry === 'object' ? a.addressCountry?.name : a?.addressCountry;
    return [a?.addressLocality, a?.addressRegion, country].map(str).filter(Boolean).join(', ');
  });
  return [...new Set(parts.filter(Boolean))].join('; ');
}

const WORKLOAD: Record<string, JobFields['workload']> = { FULL_TIME: 'full_time', PART_TIME: 'part_time', CONTRACTOR: 'contract', TEMPORARY: 'contract', INTERN: 'internship' };

function metaTags(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3];
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !map.has(key)) map.set(key, decodeEntities(attrs.content).trim());
  }
  return map;
}

export function parseJobPage(html: string): JobFields {
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const job = findJobPosting(data);
    if (!job) continue;
    const org = job.hiringOrganization;
    const remote = /TELECOMMUTE/i.test(str(job.jobLocationType));
    const types = (Array.isArray(job.employmentType) ? job.employmentType : [job.employmentType]).map((t: unknown) => str(t).toUpperCase());
    const fields: JobFields = {
      position: decodeEntities(str(job.title)),
      company: decodeEntities(typeof org === 'string' ? org : str(org?.name)),
      location: formatLocation(job.jobLocation) || (remote ? 'Remote' : ''),
      pay: formatPay(job.baseSalary ?? job.estimatedSalary),
      description: htmlToText(str(job.description)),
      workload: types.map((t: string) => WORKLOAD[t]).find(Boolean),
      work_type: remote ? 'remote' : undefined,
    };
    return Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) as JobFields;
  }

  // No structured data: fall back to OpenGraph / standard meta tags.
  const meta = metaTags(html);
  const title = meta.get('og:title') || decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').trim();
  const fields: JobFields = {
    position: title,
    company: meta.get('og:site_name'),
    description: htmlToText(meta.get('og:description') || meta.get('description') || ''),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) as JobFields;
}

// Greenhouse's newer job pages (job-boards.greenhouse.io) have no structured data in the HTML,
// so read the same job from Greenhouse's public Job Board API instead.
export function greenhouseApiUrl(raw: string): string | null {
  const url = checkUrl(raw);
  const m = /^\/([\w-]+)\/jobs\/(\d+)/.exec(url.pathname);
  return /^(job-)?boards\.greenhouse\.io$/.test(url.hostname) && m ? `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}` : null;
}

export function parseGreenhouseJob(json: string): JobFields {
  const job = JSON.parse(json);
  const location = str(job.location?.name);
  const fields: JobFields = {
    position: str(job.title),
    company: str(job.company_name),
    location,
    description: htmlToText(str(job.content)),
    work_type: /remote/i.test(location) ? 'remote' : undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) as JobFields;
}

export async function autofill(raw: string): Promise<JobFields> {
  const gh = greenhouseApiUrl(raw);
  const fields = gh ? parseGreenhouseJob(await fetchJobPage(gh, 'json')) : parseJobPage(await fetchJobPage(raw));
  if (!fields.position && !fields.description) throw new AutofillError("Couldn't find job details on that page. Paste the description instead.");
  return fields;
}
