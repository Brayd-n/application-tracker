import { useEffect, useState, type FormEvent } from 'react';
import { api, KIND, OUTCOME, STATUS, WORK_TYPE, WORKLOAD, today, type Application, type Event } from './api.ts';

const FIELDS = ['company', 'position', 'work_type', 'location', 'link', 'description', 'pay', 'workload', 'status', 'notes', 'applied_on', 'follow_up_on'] as const;
type Form = Pick<Application, (typeof FIELDS)[number]>;

const blank = (): Form => ({
  company: '', position: '', work_type: null, location: '', link: '', description: '', pay: '',
  workload: null, status: 'applied', notes: '', applied_on: today(), follow_up_on: null,
});

function Select<T extends string>({ label, value, options, onChange, empty }: { label: string; value: T | null; options: Record<T, string>; onChange: (v: T | null) => void; empty?: string }) {
  return (
    <label>
      {label}
      <select value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as T | null)}>
        {empty !== undefined && <option value="">{empty}</option>}
        {(Object.entries(options) as [T, string][]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </label>
  );
}

export function Detail({ id }: { id?: string }) {
  const [form, setForm] = useState<Form>(blank);
  const [events, setEvents] = useState<Event[]>([]);
  const [loaded, setLoaded] = useState(!id);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<Application>('GET', `/api/applications/${id}`).then(
      (a) => {
        setForm(Object.fromEntries(FIELDS.map((f) => [f, a[f] ?? (f === 'description' ? '' : a[f])])) as Form);
        setEvents(a.events ?? []);
        setLoaded(true);
      },
      (e) => setMsg({ text: e.message, error: true }),
    );
  useEffect(() => {
    if (id) load();
  }, [id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const autofill = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const found = await api<Partial<Form>>('POST', '/api/autofill', { url: form.link });
      const filled = (Object.keys(found) as (keyof Form)[]).filter((k) => !form[k]);
      setForm((f) => ({ ...f, ...Object.fromEntries(filled.map((k) => [k, found[k]])) }));
      setMsg({ text: filled.length ? `Filled in: ${filled.join(', ').replace(/_/g, ' ')}. Check them before saving.` : 'Found the page, but every field it had is already filled in.' });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...form, link: form.link.trim() };
      if (id) {
        await api('PUT', `/api/applications/${id}`, body);
        setMsg({ text: 'Saved.' });
      } else {
        const { id: newId } = await api<{ id: string }>('POST', '/api/applications', body);
        location.hash = `#/app/${newId}`;
      }
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${form.company || 'this application'} and all of its interviews and files?`)) return;
    await api('DELETE', `/api/applications/${id}`);
    location.hash = '#/';
  };

  const addEvent = async () => {
    await api('POST', `/api/applications/${id}/events`, { kind: 'interview', happened_on: today(), outcome: 'in_progress' });
    load();
  };

  if (!loaded) return <main>{msg ? <p className="error">{msg.text}</p> : <p className="muted">Loading…</p>}</main>;

  return (
    <main className="detail">
      <p><a href="#/">← All applications</a></p>
      <h1>{id ? `${form.company} — ${form.position}` : 'New application'}</h1>
      <form onSubmit={save} className="app-form">
        <div className="link-row">
          <label className="grow">
            Job link
            <input type="url" value={form.link} onChange={(e) => set('link', e.target.value)} placeholder="https://…" />
          </label>
          <button type="button" onClick={autofill} disabled={busy || !/^https?:\/\//.test(form.link)}>Fill in from link</button>
          {id && form.link && <a className="button" href={form.link} target="_blank" rel="noopener noreferrer">Open</a>}
        </div>
        <p className="muted small">Works with pages that publish job details (most company career sites, Greenhouse, Lever, Workday). LinkedIn and Indeed don't allow it, so paste the description below instead.</p>
        {msg && <p className={msg.error ? 'error' : 'notice'} role="status">{msg.text}</p>}

        <div className="grid">
          <label>Company<input required maxLength={200} value={form.company} onChange={(e) => set('company', e.target.value)} /></label>
          <label>Position<input required maxLength={200} value={form.position} onChange={(e) => set('position', e.target.value)} /></label>
          <Select label="Status" value={form.status} options={STATUS} onChange={(v) => set('status', v ?? 'applied')} />
          <Select label="Work type" value={form.work_type} options={WORK_TYPE} onChange={(v) => set('work_type', v)} empty="—" />
          <label>Location<input maxLength={200} value={form.location} onChange={(e) => set('location', e.target.value)} /></label>
          <label>Estimated pay<input maxLength={200} value={form.pay} onChange={(e) => set('pay', e.target.value)} placeholder="$55,000 or $25/hr" /></label>
          <Select label="Workload" value={form.workload} options={WORKLOAD} onChange={(v) => set('workload', v)} empty="—" />
          <label>Applied on<input type="date" value={form.applied_on ?? ''} onChange={(e) => set('applied_on', e.target.value || null)} /></label>
          <label>Follow up on<input type="date" value={form.follow_up_on ?? ''} onChange={(e) => set('follow_up_on', e.target.value || null)} /></label>
        </div>
        <label>Notes<textarea rows={3} maxLength={20000} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        <label>
          Job description <span className="muted small">(kept with the application, even if the posting is taken down)</span>
          <textarea rows={12} maxLength={100000} value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>{id ? 'Save changes' : 'Add application'}</button>
          {id && <button type="button" className="danger" onClick={remove}>Delete application</button>}
        </div>
      </form>

      {id && (
        <section className="timeline">
          <h2>Interviews and follow-ups</h2>
          {events.length === 0 && <p className="muted">Nothing logged yet.</p>}
          <ol>
            {events.map((ev) => <EventItem key={ev.id} ev={ev} reload={load} />)}
          </ol>
          <button onClick={addEvent}>+ Add interview or follow-up</button>
        </section>
      )}
    </main>
  );
}

function EventItem({ ev, reload }: { ev: Event; reload: () => void }) {
  const [e, setE] = useState(ev);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Event>(k: K, v: Event[K]) => {
    setE((x) => ({ ...x, [k]: v }));
    setDirty(true);
  };

  const save = async () => {
    try {
      const { kind, happened_on, with_whom, outcome, notes } = e;
      await api('PUT', `/api/events/${ev.id}`, { kind, happened_on, with_whom, outcome, notes });
      setDirty(false);
      setError('');
    } catch (x) {
      setError((x as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm('Delete this entry and its files?')) return;
    await api('DELETE', `/api/events/${ev.id}`);
    reload();
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    for (const file of files) {
      const body = new FormData();
      body.append('file', file);
      try {
        await api('POST', `/api/events/${ev.id}/attachments`, body);
      } catch (x) {
        setError(`${file.name}: ${(x as Error).message}`);
      }
    }
    reload();
  };
  const removeFile = async (fileId: string) => {
    if (!confirm('Delete this file?')) return;
    await api('DELETE', `/api/attachments/${fileId}`);
    reload();
  };

  return (
    <li className={`event oc-border-${e.outcome ?? 'none'}`}>
      <div className="grid">
        <Select label="Type" value={e.kind} options={KIND} onChange={(v) => set('kind', v ?? 'other')} />
        <label>Date<input type="date" value={e.happened_on ?? ''} onChange={(x) => set('happened_on', x.target.value || null)} /></label>
        <label>With<input maxLength={200} value={e.with_whom} onChange={(x) => set('with_whom', x.target.value)} placeholder="Name, role" /></label>
        <Select label="How it went" value={e.outcome} options={OUTCOME} onChange={(v) => set('outcome', v)} empty="—" />
      </div>
      <label>Notes<textarea rows={3} maxLength={20000} value={e.notes} onChange={(x) => set('notes', x.target.value)} /></label>
      <div className="files">
        {ev.attachments.map((f) => (
          <figure key={f.id}>
            {f.mime.startsWith('image/') ? (
              <a href={`/api/attachments/${f.id}`} target="_blank" rel="noopener"><img src={`/api/attachments/${f.id}`} alt={f.filename} loading="lazy" /></a>
            ) : (
              <a className="file" href={`/api/attachments/${f.id}?download`}>📄 {f.filename}</a>
            )}
            <figcaption>
              <span className="muted small">{(f.size / 1024).toFixed(0)} KB</span>
              <button className="link small" onClick={() => removeFile(f.id)}>Remove</button>
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={save}>{dirty ? 'Save' : 'Saved'}</button>
        <label className="button upload">
          Attach files
          <input type="file" multiple accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(x) => { upload(x.target.files); x.target.value = ''; }} />
        </label>
        <button className="danger link" onClick={remove}>Delete entry</button>
      </div>
      {error && <p className="error">{error}</p>}
    </li>
  );
}
