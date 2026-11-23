import { createContext } from 'react';

export type User = { email: string; name: string };
export const UserContext = createContext<User>({ email: '', name: '' });

export type Status = 'saved' | 'applied' | 'interviewing' | 'offer' | 'hired' | 'rejected' | 'withdrawn';
export type Outcome = 'passed' | 'denied' | 'abandoned' | 'in_progress' | 'technical_assignment' | 'hired';

export type Application = {
  id: string;
  company: string;
  position: string;
  work_type: 'on_site' | 'hybrid' | 'remote' | null;
  location: string;
  link: string;
  description?: string;
  pay: string;
  workload: 'full_time' | 'part_time' | 'contract' | 'internship' | null;
  status: Status;
  notes: string;
  applied_on: string | null;
  follow_up_on: string | null;
  updated_at?: string;
  event_count?: number;
  last_outcome?: Outcome | null;
  next_event?: { date: string; kind: string } | null;
  mail_count?: number;
  unread_mail?: number;
  events?: Event[];
  emails?: Email[];
};

export type Email = {
  id: string;
  application_id?: string;
  company?: string;
  gmail_id: string;
  from_name: string;
  from_email: string;
  subject: string;
  received_at: string;
  read: boolean;
};

export const gmailLink = (gmailId: string, account: string) =>
  `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#all/${encodeURIComponent(gmailId)}`;

// "Nov 14" this year, "Nov 14, 2025" otherwise. Accepts 'YYYY-MM-DD' or a full timestamp.
export const niceDate = (d: string | null) => {
  if (!d) return '';
  const date = new Date(d.length === 10 ? d + 'T00:00' : d);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
};
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export type Attachment = { id: string; filename: string; mime: string; size: number };
export type Event = {
  id: string;
  kind: string;
  happened_on: string | null;
  with_whom: string;
  outcome: Outcome | null;
  notes: string;
  attachments: Attachment[];
};

export const STATUS: Record<Status, string> = {
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};
export const OUTCOME: Record<Outcome, string> = {
  in_progress: 'In progress',
  passed: 'Passed',
  technical_assignment: 'Technical assignment',
  denied: 'Denied',
  abandoned: 'Abandoned',
  hired: 'Hired',
};
export const KIND: Record<string, string> = {
  phone_screen: 'Phone screen',
  interview: 'Interview',
  technical: 'Technical',
  follow_up: 'Follow-up',
  offer: 'Offer',
  other: 'Other',
};
export const WORK_TYPE = { on_site: 'On-site', hybrid: 'Hybrid', remote: 'Remote' };
export const WORKLOAD = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', internship: 'Internship' };

export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the user's time zone

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}
