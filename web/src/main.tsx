import { StrictMode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import { api, gmailLink, shortDate, UserContext, type Email, type User } from './api.ts';
import { Overview } from './Overview.tsx';
import { Detail } from './Detail.tsx';
import './styles.css';


// Hash routes: #/ (overview), #/new, #/app/<id>, #/account
function useRoute() {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => {
      setRoute(location.hash.slice(1) || '/');
      window.scrollTo(0, 0);
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M9 10.5h14M9 16h14M9 21.5h8" stroke="var(--accent-text)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

const GoogleG = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

function Landing() {
  const failed = new URLSearchParams(location.search).has('login');
  return (
    <div className="landing">
      <header className="landing-top">
        <span className="brand"><Logo /><span>Application Tracker</span></span>
        <a className="button" href="/auth/google">Sign in</a>
      </header>
      <section className="hero">
        <h1>Your job search, organized.</h1>
        <p>Applications, interviews, and follow-ups in one private workspace.</p>
        {failed && <p className="error">Sign-in didn't complete. Please try again.</p>}
        <a className="google-button" href="/auth/google"><GoogleG /> Continue with Google</a>
        <div className="fine">Free. Your data is private to your account.</div>
      </section>
      <div className="preview">
        <img src="/preview.webp" width="1600" height="900" alt="Application Tracker showing a table of job applications with statuses, interview results, and upcoming follow-ups" />
      </div>
      <footer>
        © 2026 Application Tracker · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
      </footer>
    </div>
  );
}

// Closes a <details> menu when clicking elsewhere.
function useOutsideClose() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    addEventListener('click', on);
    return () => removeEventListener('click', on);
  }, []);
  return ref;
}

function Notifications() {
  const user = useContext(UserContext);
  const ref = useOutsideClose();
  const [items, setItems] = useState<Email[]>([]);
  const known = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    const list = await api<Email[]>('GET', '/api/notifications').catch(() => null);
    if (!list) return;
    // Desktop notification for replies that arrived since the last check (only if the user turned them on).
    if (known.current && 'Notification' in window && Notification.permission === 'granted') {
      for (const m of list.filter((m) => !m.read && !known.current!.has(m.id))) {
        new Notification(`Reply from ${m.company}`, { body: m.subject || m.from_name || m.from_email, icon: '/favicon.svg' });
      }
    }
    known.current = new Set(list.map((m) => m.id));
    setItems(list);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 2 * 60_000);
    return () => clearInterval(t);
  }, [load]);

  const unread = items.filter((m) => !m.read).length;
  useEffect(() => {
    document.title = unread ? `(${unread}) Application Tracker` : 'Application Tracker';
  }, [unread]);

  const onToggle = async (open: boolean) => {
    if (open && unread) {
      await api('POST', '/api/notifications/read');
      setTimeout(() => setItems((xs) => xs.map((m) => ({ ...m, read: true }))), 1500);
    }
  };

  return (
    <details className="menu" ref={ref} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}>
      <summary className="button icon-button" aria-label={`Notifications${unread ? `, ${unread} new` : ''}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        {unread > 0 && <span className="dot">{unread}</span>}
      </summary>
      <div className="menu-panel notif-panel">
        <h3>
          Email replies
          {'Notification' in window && Notification.permission === 'default' && (
            <button className="link small" onClick={() => Notification.requestPermission().then(load)}>Turn on desktop alerts</button>
          )}
        </h3>
        {items.length ? (
          <ul className="mail-list">
            {items.slice(0, 20).map((m) => (
              <li key={m.id} className={m.read ? '' : 'unread'}>
                <span><a href={`#/app/${m.application_id}`}>{m.company}</a> <span className="muted small">· {shortDate(m.received_at)}</span></span>
                <a className="subject" href={gmailLink(m.gmail_id, user.email)} target="_blank" rel="noopener noreferrer">{m.subject || '(no subject)'}</a>
                <span className="muted small">{m.from_name || m.from_email}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">
            No replies yet. <a href="#/account">Connect Gmail</a> to be notified when a company you applied to emails you.
          </p>
        )}
      </div>
    </details>
  );
}

function AccountMenu({ user }: { user: User }) {
  const ref = useOutsideClose();
  const signOut = async () => {
    await api('POST', '/auth/logout');
    location.href = '/';
  };
  const initial = (user.name || user.email).trim()[0]?.toUpperCase() ?? '?';
  return (
    <details className="menu" ref={ref}>
      <summary aria-label="Account menu"><span className="avatar">{initial}</span></summary>
      <div className="menu-panel">
        <div className="who"><strong>{user.name || 'Signed in'}</strong><span className="muted small">{user.email}</span></div>
        <a href="#/account" onClick={() => ref.current && (ref.current.open = false)}>Settings</a>
        <a href="/api/export.csv">Export to CSV</a>
        <button onClick={signOut}>Sign out</button>
      </div>
    </details>
  );
}

type GmailStatus = { available: boolean; connected: boolean; last_checked_at?: string };

function Account({ user }: { user: User }) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [gmailMsg, setGmailMsg] = useState('');
  const result = new URLSearchParams(location.hash.split('?')[1]).get('gmail');

  const loadGmail = () => api<GmailStatus>('GET', '/api/gmail').then(setGmail, () => {});
  useEffect(() => {
    loadGmail();
  }, []);

  const check = async () => {
    setGmailMsg('Checking…');
    try {
      const { found } = await api<{ found: number }>('POST', '/api/gmail/check');
      setGmailMsg(found ? `Found ${found} new ${found === 1 ? 'reply' : 'replies'}.` : 'No new replies.');
      loadGmail();
    } catch (e) {
      setGmailMsg((e as Error).message);
    }
  };
  const disconnect = async () => {
    await api('DELETE', '/api/gmail');
    setGmailMsg('Gmail disconnected and access revoked.');
    loadGmail();
  };
  const remove = async () => {
    try {
      await api('DELETE', '/api/account');
      location.href = '/';
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const RESULT: Record<string, string> = {
    connected: 'Gmail connected. Your inbox is checked every 10 minutes.',
    denied: 'Gmail access was not granted, so nothing was connected.',
    'wrong-account': 'Please connect the same Google account you signed in with.',
    failed: "Connecting Gmail didn't complete. Please try again.",
    unavailable: "Gmail connection isn't available right now.",
  };

  return (
    <main className="narrow">
      <h1>Settings</h1>

      <section className="panel">
        <h2>Email replies</h2>
        <p className="muted">
          Get notified when a company you applied to emails you. Only the sender, subject, and date of messages are read (never the message
          content), and only messages that match one of your applications are saved.
        </p>
        {result && RESULT[result] && <p className={result === 'connected' ? 'notice' : 'error'}>{RESULT[result]}</p>}
        {gmail?.connected ? (
          <>
            <p>
              <span className="pill st-hired">Connected</span>{' '}
              <span className="muted small">
                {gmail.last_checked_at ? `Last checked ${new Date(gmail.last_checked_at).toLocaleString()}` : 'First check in progress'}
              </span>
            </p>
            <div className="actions">
              <button onClick={check}>Check now</button>
              <button className="danger" onClick={disconnect}>Disconnect Gmail</button>
              {gmailMsg && <span className="muted small">{gmailMsg}</span>}
            </div>
          </>
        ) : (
          <div className="actions">
            <a className="button primary" href="/auth/gmail" aria-disabled={gmail?.available === false}>Connect Gmail</a>
            {gmailMsg && <span className="muted small">{gmailMsg}</span>}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Your data</h2>
        <p className="muted">Signed in with Google as <strong>{user.email}</strong>.</p>
        <div className="actions">
          <a className="button" href="/api/export.csv">Export to CSV</a>
        </div>
      </section>

      <section className="panel">
        <h2>Delete account</h2>
        <p className="muted">Permanently deletes your account and every application, interview, file, and email match. This can't be undone.</p>
        <label>
          <span>Type <strong>delete</strong> to confirm</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <div className="actions">
          <button className="danger" disabled={confirm !== 'delete'} onClick={remove}>Delete account and data</button>
          {error && <span className="error">{error}</span>}
        </div>
      </section>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const route = useRoute();
  useEffect(() => {
    api<User>('GET', '/api/me').then(setUser, () => setUser(null));
  }, []);

  if (user === undefined) return null;
  if (user === null) return <Landing />;

  const path = route.split('?')[0];
  const appId = /^\/app\/([\w-]+)$/.exec(path)?.[1];

  return (
    <UserContext.Provider value={user}>
      <header className="top">
        <a href="#/" className="brand"><Logo /><span>Application Tracker</span></a>
        <nav>
          <a className={`tab ${path === '/' ? 'active' : ''}`} href="#/">Applications</a>
          <a className={`tab ${path === '/account' ? 'active' : ''}`} href="#/account">Settings</a>
        </nav>
        <span className="spacer" />
        <div className="right">
          <a className="button primary" href="#/new">New application</a>
          <Notifications />
          <AccountMenu user={user} />
        </div>
      </header>
      {path === '/new' ? <Detail key="new" /> : appId ? <Detail key={appId} id={appId} /> : path === '/account' ? <Account user={user} /> : <Overview />}
      <footer className="app-footer">
        <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
      </footer>
    </UserContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
