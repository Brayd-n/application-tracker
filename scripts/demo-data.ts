// Local development only: fills the database with fictional sample applications for a "demo" user
// and prints a session token. In the browser at http://localhost:3000 run
//   document.cookie = "__Host-session=<token>; Path=/; Secure"
// and reload to be signed in without Google.  Usage: node scripts/demo-data.ts
import { createPool } from '../server/db.ts';
import { createSession } from '../server/auth.ts';
const pool = createPool();
const { rows: [u] } = await pool.query("INSERT INTO users (google_sub, email, name) VALUES ('demo', 'demo@example.com', 'Demo User') ON CONFLICT (google_sub) DO UPDATE SET name='Demo User' RETURNING id");
await pool.query('DELETE FROM applications WHERE user_id=$1', [u.id]);
const d = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA');
const apps = [
  ['Northwind Analytics', 'Junior Software Engineer', 'hybrid', 'Reston, VA', '$72,000–$85,000 / year', 'full_time', 'interviewing', -20, 2, [['phone_screen', -14, 'passed', 'Recruiter, Dana'], ['technical', -6, 'technical_assignment', 'Eng. manager']]],
  ['Bluefield Health', 'Application Support Analyst', 'on_site', 'Fairfax, VA', '$28/hr', 'contract', 'applied', -9, 1, []],
  ['Harbor & Pine', 'Associate Developer', 'remote', 'Remote', '$65,000 / year', 'full_time', 'offer', -35, null, [['interview', -25, 'passed', 'Team lead'], ['interview', -15, 'passed', 'Director'], ['offer', -3, 'hired', 'HR']]],
  ['Cobalt Robotics', 'Software Engineer I', 'on_site', 'Baltimore, MD', '$80,000 / year', 'full_time', 'rejected', -40, null, [['interview', -30, 'denied', 'Panel']]],
  ['Mesa Labs', 'QA Automation Engineer', 'hybrid', 'Silver Spring, MD', '$60,000–$70,000', 'full_time', 'applied', -4, 6, []],
  ['Lantern Civic Tech', 'Full-Stack Developer', 'remote', 'Remote (US)', '', 'part_time', 'saved', null, null, []],
  ['Redline Security', 'SOC Analyst I', 'on_site', 'Tysons, VA', '$58,800 / year', 'full_time', 'withdrawn', -50, null, [['phone_screen', -44, 'abandoned', 'Recruiter']]],
  ['Orchard Data', 'Data Engineer (New Grad)', 'hybrid', 'Washington, DC', '$90,000 / year', 'full_time', 'interviewing', -12, null, [['phone_screen', -5, 'passed', 'Recruiter'], ['interview', 3, 'in_progress', 'Hiring manager']]],
] as const;
for (const [company, position, wt, loc, pay, wl, status, applied, fu, events] of apps) {
  const { rows: [a] } = await pool.query(
    `INSERT INTO applications (user_id, company, position, work_type, location, pay, workload, status, applied_on, follow_up_on, link, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'https://example.com/careers/123','About the role\n\nYou will build and maintain internal tools.\n\n• Java or TypeScript\n• SQL') RETURNING id`,
    [u.id, company, position, wt, loc, pay, wl, status, applied === null ? null : d(applied), fu === null ? null : d(fu)]);
  for (const [kind, when, outcome, who] of events) {
    await pool.query('INSERT INTO events (application_id, user_id, kind, happened_on, outcome, with_whom, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [a.id, u.id, kind, d(when), outcome, who, kind === 'technical' ? 'Take-home: build a small REST API with tests. Due in 5 days.' : '']);
  }
}
console.log(await createSession(pool, u.id));
await pool.end();
