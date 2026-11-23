import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.ts';
import { Overview } from './Overview.tsx';
import { Detail } from './Detail.tsx';
import './styles.css';

type User = { email: string; name: string };

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

function SignIn() {
  const failed = new URLSearchParams(location.search).has('login');
  return (
    <main className="landing">
      <h1>Application Tracker</h1>
      <p className="lead">Keep track of every job application in one place: where you applied, the job description, each interview, and when to follow up.</p>
      <ul className="features">
        <li>Paste a job link to fill in the company, title, pay, and description (works with most company career pages, Greenhouse, Lever, and Workday).</li>
        <li>The job description is saved with the application, so you still have it after the posting is taken down.</li>
        <li>Log each interview and follow-up with notes and screenshots or files.</li>
        <li>Sort and filter in a table, or drag cards across a board. Export everything to CSV at any time.</li>
      </ul>
      {failed && <p className="error">Sign-in didn't complete. Please try again.</p>}
      <a className="button primary big" href="/auth/google">Sign in with Google</a>
      <p className="muted small">Your tracker is private to your account. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
    </main>
  );
}

function Account({ user }: { user: User }) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const remove = async () => {
    try {
      await api('DELETE', '/api/account');
      location.href = '/';
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <main className="narrow">
      <h1>Account</h1>
      <p>Signed in with Google as <strong>{user.email}</strong>.</p>
      <h2>Export</h2>
      <p>Download all of your applications and interviews as a CSV file (opens in Excel or Google Sheets).</p>
      <a className="button" href="/api/export.csv">Download CSV</a>
      <h2>Delete account</h2>
      <p>This permanently deletes your account, every application, interview, and uploaded file. It can't be undone.</p>
      <label>
        Type <strong>delete</strong> to confirm
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <button className="danger" disabled={confirm !== 'delete'} onClick={remove}>Delete my account and data</button>
      {error && <p className="error">{error}</p>}
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
  if (user === null) return <SignIn />;

  const signOut = async () => {
    await api('POST', '/auth/logout');
    location.href = '/';
  };
  const appId = /^\/app\/([\w-]+)$/.exec(route)?.[1];

  return (
    <>
      <header className="top">
        <a href="#/" className="brand">Application Tracker</a>
        <nav>
          <a className="button primary" href="#/new">+ New application</a>
          <a href="#/account">Account</a>
          <button className="link" onClick={signOut}>Sign out</button>
        </nav>
      </header>
      {route === '/new' ? <Detail key="new" /> : appId ? <Detail key={appId} id={appId} /> : route === '/account' ? <Account user={user} /> : <Overview />}
      <footer className="muted small">
        <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="https://github.com/Brayd-n/application-tracker">Source</a>
      </footer>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
