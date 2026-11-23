import { useEffect, useMemo, useState } from 'react';
import { api, niceDate, KIND, OUTCOME, STATUS, WORK_TYPE, WORKLOAD, today, type Application, type Status } from './api.ts';

type SortKey = 'company' | 'position' | 'work_type' | 'location' | 'pay' | 'workload' | 'status' | 'applied_on' | 'follow_up_on';
const STATUSES = Object.keys(STATUS) as Status[];
const OPEN: Status[] = ['saved', 'applied', 'interviewing', 'offer'];

function useSaved<T extends string>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {}
  };
  return [value, set] as const;
}

export function Overview() {
  const [apps, setApps] = useState<Application[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useSaved<'table' | 'board'>('view', 'table');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useSaved<string>('status-filter', 'all');
  const [workType, setWorkType] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'applied_on', dir: -1 });
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    api<Application[]>('GET', '/api/applications').then(setApps, (e) => setError(e.message));
  }, []);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (apps ?? [])
      .filter((a) => (status === 'all' ? true : status === 'open' ? OPEN.includes(a.status) : a.status === status))
      .filter((a) => !workType || a.work_type === workType)
      .filter((a) => !q || [a.company, a.position, a.location, a.notes].some((s) => s.toLowerCase().includes(q)))
      .sort((x, y) => {
        const a = x[sort.key] ?? '', b = y[sort.key] ?? '';
        if (sort.key === 'status') return (STATUSES.indexOf(x.status) - STATUSES.indexOf(y.status)) * sort.dir;
        if (a === b) return 0;
        if (a === '') return 1; // empty values last in either direction
        if (b === '') return -1;
        return String(a).localeCompare(String(b), undefined, { numeric: true }) * sort.dir;
      });
  }, [apps, search, status, workType, sort]);

  if (error) return <main><p className="error">{error}</p></main>;
  if (!apps) return <main><p className="muted">Loading…</p></main>;

  const applied = apps.filter((a) => a.status !== 'saved');
  const responded = applied.filter((a) => (a.event_count ?? 0) > 0 || ['interviewing', 'offer', 'hired', 'rejected'].includes(a.status));
  const stats = [
    ['Applied', applied.length],
    ['Interviewing', apps.filter((a) => a.status === 'interviewing').length],
    ['Offers', apps.filter((a) => a.status === 'offer' || a.status === 'hired').length],
    ['Response rate', applied.length ? `${Math.round((responded.length / applied.length) * 100)}%` : '–'],
  ];

  const now = today();
  const upcoming = apps
    .flatMap((a) => [
      ...(a.follow_up_on && OPEN.includes(a.status) ? [{ a, date: a.follow_up_on, what: 'Follow up' }] : []),
      ...(a.next_event && a.next_event.date >= now ? [{ a, date: a.next_event.date, what: KIND[a.next_event.kind] ?? 'Event' }] : []),
    ])
    .sort((x, y) => x.date.localeCompare(y.date))
    .slice(0, 8);

  const header = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="sort" onClick={() => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : 1 })}>
        {label} {sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : ''}
      </button>
    </th>
  );

  const move = async (id: string, to: Status) => {
    const a = apps.find((x) => x.id === id);
    if (!a || a.status === to) return;
    setApps(apps.map((x) => (x.id === id ? { ...x, status: to } : x)));
    try {
      await api('PUT', `/api/applications/${id}`, { company: a.company, position: a.position, status: to });
    } catch (e) {
      setApps(apps);
      setError((e as Error).message);
    }
  };

  if (!apps.length)
    return (
      <main className="narrow">
        <section className="panel empty">
          <h2>No applications yet</h2>
          <p className="muted">Add your first application. Paste the job link and the details fill in automatically.</p>
          <div className="actions"><a className="button primary" href="#/new">New application</a></div>
        </section>
      </main>
    );

  return (
    <main>
      <div className="page-head"><h1>Applications</h1></div>
      <section className="stats">
        {stats.map(([label, value]) => (
          <div key={label} className="stat">
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
        <div className="stat upcoming">
          <div className="stat-label">Coming up</div>
          {upcoming.length ? (
            <ul>
              {upcoming.map((u, i) => (
                <li key={i} className={u.date < now ? 'overdue' : ''}>
                  <span className="date">{u.date === now ? 'Today' : niceDate(u.date)}</span>
                  <span>{u.what} · <a href={`#/app/${u.a.id}`}>{u.a.company}</a></span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing scheduled. Set a follow-up date on an application to see it here.</p>
          )}
        </div>
      </section>

      <section className="toolbar">
        <input type="search" placeholder="Search company, position, notes…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        {view === 'table' && (
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
            <option value="all">All statuses</option>
            <option value="open">Open (not closed)</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS[s]}</option>)}
          </select>
        )}
        <select value={workType} onChange={(e) => setWorkType(e.target.value)} aria-label="Work type filter">
          <option value="">Any work type</option>
          {Object.entries(WORK_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button>
          <button aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</button>
        </div>
      </section>

      {view === 'table' ? (
        <div className="table-wrap">
          <table className="apps">
            <thead>
              <tr>
                {header('company', 'Company')}
                {header('position', 'Position')}
                {header('work_type', 'Work type')}
                {header('location', 'Where')}
                {header('pay', 'Pay')}
                {header('workload', 'Workload')}
                {header('status', 'Status')}
                <th>Latest interview</th>
                {header('applied_on', 'Applied')}
                {header('follow_up_on', 'Follow up')}
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id} className={`row-${a.status}`} onClick={() => (location.hash = `#/app/${a.id}`)}>
                  <td className="company">
                    <a href={`#/app/${a.id}`} onClick={(e) => e.stopPropagation()}>{a.company}</a>
                    {a.unread_mail ? <> <span className="pill badge-mail" title="New email from this company">New reply</span></> : null}
                  </td>
                  <td>{a.position}</td>
                  <td>{a.work_type && <span className={`pill wt-${a.work_type}`}>{WORK_TYPE[a.work_type]}</span>}</td>
                  <td>{a.location}</td>
                  <td>{a.pay}</td>
                  <td>{a.workload && WORKLOAD[a.workload]}</td>
                  <td><span className={`pill st-${a.status}`}>{STATUS[a.status]}</span></td>
                  <td>{a.last_outcome && <span className={`pill oc-${a.last_outcome}`}>{OUTCOME[a.last_outcome]}</span>}{a.event_count ? <span className="muted small"> ({a.event_count})</span> : null}</td>
                  <td className="nowrap num">{niceDate(a.applied_on)}</td>
                  <td className={`nowrap num ${a.follow_up_on && a.follow_up_on < now && OPEN.includes(a.status) ? 'overdue' : ''}`}>{niceDate(a.follow_up_on)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <p className="empty-row">No applications match these filters.</p>}
        </div>
      ) : (
        <div className="board">
          {STATUSES.map((s) => (
            <section
              key={s}
              className={`column col-${s}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) move(dragging, s);
                setDragging(null);
              }}
            >
              <h2><span className={`pill st-${s}`}>{STATUS[s]}</span> <span className="muted">{shown.filter((a) => a.status === s).length}</span></h2>
              {shown.filter((a) => a.status === s).map((a) => (
                <article key={a.id} className="card" draggable onDragStart={() => setDragging(a.id)} onDragEnd={() => setDragging(null)}>
                  <a href={`#/app/${a.id}`}>{a.company}</a>
                  {a.unread_mail ? <span className="pill badge-mail">New reply</span> : null}
                  <div>{a.position}</div>
                  <div className="muted small">{[a.work_type && WORK_TYPE[a.work_type], a.location, a.pay].filter(Boolean).join(' · ')}</div>
                  {a.last_outcome && <span className={`pill oc-${a.last_outcome}`}>{OUTCOME[a.last_outcome]}</span>}
                  <select value={a.status} onChange={(e) => move(a.id, e.target.value as Status)} aria-label={`Status of ${a.company}`}>
                    {STATUSES.map((t) => <option key={t} value={t}>{STATUS[t]}</option>)}
                  </select>
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
