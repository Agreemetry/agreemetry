import { useCallback, useEffect, useState } from 'react';
import { useApp, type ProjectView } from '../app';
import { Field, Notice } from '../components';
import type { LabSummary, Webhook, WebhookDelivery } from '../../core/types';

/** Events a webhook can subscribe to; they mirror agm_webhook_events() in the database. */
export const WEBHOOK_EVENTS: [string, string][] = [
  ['assessment.submit', 'A judgment is submitted'],
  ['assessment.reopen', 'A submitted judgment is reopened'],
  ['resolution.propose', 'A resolution is proposed'],
  ['resolution.approve', 'A resolution is approved'],
  ['resolution.finalize', 'A resolution becomes final'],
  ['resolution.reopen', 'A final decision is reopened'],
  ['item.escalate', 'An item is escalated'],
  ['items.import', 'Items are imported'],
  ['items.delete', 'Items are deleted'],
  ['assignments.generate', 'Assignments are generated'],
  ['disclosure.open', 'Judgments are disclosed'],
  ['project.status', 'The project status changes'],
  ['project.update', 'The configuration changes'],
  ['project.lab', 'The project moves to or from a lab'],
  ['member.upsert', 'A team member is added or changed'],
  ['member.invite', 'Someone is invited'],
  ['member.accept_invite', 'An invitation is accepted'],
  ['member.lab_grant', 'Lab administration is granted'],
  ['member.lab_revoke', 'Lab administration ends'],
  ['results.publish', 'Results are published to the API'],
];

/** Settings > Lab: which lab owns the project. */
export function Ownership({ v }: { v: ProjectView }) {
  const { backend, toast, fail } = useApp();
  const p = v.data.project;
  const [labs, setLabs] = useState<LabSummary[]>([]);
  const [target, setTarget] = useState(p.labId ?? '');
  useEffect(() => {
    void backend.listLabs().then(setLabs, fail);
  }, [backend, fail]);
  useEffect(() => setTarget(p.labId ?? ''), [p.labId]);
  const current = labs.find((l) => l.lab.id === p.labId);
  const viaLab = v.data.memberships.filter((m) => m.viaLab && m.active);
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Owner</h2>
        <p className="ink2" style={{ margin: 0 }}>
          {p.labId
            ? current ? <>This project belongs to the lab <a href={`#/labs/${current.lab.id}`}>{current.lab.name}</a>.</> : 'This project belongs to a lab you are not a member of.'
            : 'This is a personal project: only the people on its team can see it.'}
        </p>
        <p className="ink2" style={{ margin: 0 }}>
          In a lab, the lab's owners and administrators become administrators of the project, so administration continues when people move on. Anyone who already has a role on the project keeps it: adjudicators stay blind. Taking a project out of a lab ends the administrator access that came from the lab.
        </p>
        <div className="row">
          <select aria-label="Owner" value={target} onChange={(e) => setTarget(e.target.value)} style={{ flex: '1 1 240px', width: 'auto' }}>
            <option value="">Personal (no lab)</option>
            {labs.map((l) => <option key={l.lab.id} value={l.lab.id}>{l.lab.name}</option>)}
            {p.labId && !current && <option value={p.labId}>Current lab</option>}
          </select>
          <button className="btn primary" disabled={(target || '') === (p.labId ?? '')} onClick={() => backend.moveProjectToLab(p.id, target || null).then(() => { toast(target ? 'The project now belongs to the lab.' : 'The project is personal again.'); v.reload(); }, fail)}>
            {target ? 'Move to this lab' : 'Make personal'}
          </button>
        </div>
        {viaLab.length > 0 && <p className="small muted" style={{ margin: 0 }}>Administrators through the lab: {viaLab.map((m) => m.pseudonym).join(', ')}.</p>}
      </div>
    </div>
  );
}

/** Settings > Integrations: the REST API, webhooks and their deliveries (shared server). */
export function Integrations({ v }: { v: ProjectView }) {
  const { backend } = useApp();
  if (!backend.listWebhooks || !backend.apiBaseUrl) {
    return (
      <div className="card stack">
        <h2>Integrations</h2>
        <Notice tone="info">The REST API and webhooks need the shared server deployment: a local workspace lives in one browser and has no server for other platforms to call. Exports (CSV, Excel, JSON and the project archive) work everywhere.</Notice>
        <p className="ink2" style={{ margin: 0 }}>See docs/API.md and docs/DEPLOYMENT.md in the repository.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      <ApiCard v={v} />
      <Webhooks v={v} />
    </div>
  );
}

function ApiCard({ v }: { v: ProjectView }) {
  const { backend } = useApp();
  const base = backend.apiBaseUrl!();
  const key = (import.meta.env as Record<string, string | undefined>).VITE_SUPABASE_ANON_KEY ?? '<publishable key>';
  const example = [
    `curl -X POST "${base}/rpc/api_project_status" \\`,
    `  -H "apikey: ${key}" \\`,
    '  -H "X-Agreemetry-Token: $AGREEMETRY_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"p": "${v.data.project.id}"}'`,
  ].join('\n');
  return (
    <div className="card stack">
      <h2>REST API</h2>
      <p className="ink2" style={{ margin: 0 }}>
        Scripts and other platforms call the same functions as this app, with a personal token from <a href="#/account">Account</a>. Every role and blinding rule applies to a token exactly as to its owner. The publishable key below is public; the token is the secret.
      </p>
      <div className="grid cols-2">
        <Field label="Base address"><input type="text" readOnly value={base} onFocus={(e) => e.currentTarget.select()} /></Field>
        <Field label="Project identifier"><input type="text" readOnly value={v.data.project.id} onFocus={(e) => e.currentTarget.select()} /></Field>
      </div>
      <pre className="code">{example}</pre>
      <p className="small muted" style={{ margin: 0 }}>
        Useful calls: <code>api_project_status</code>, <code>api_events</code> (an audit feed with a cursor), <code>api_results</code> (the tables published from Export), <code>get_project_view</code>, <code>import_items</code>. The full list, with R and Python examples, is in docs/API.md.
      </p>
    </div>
  );
}

function Webhooks({ v }: { v: ProjectView }) {
  const { backend, toast, fail } = useApp();
  const pid = v.data.project.id;
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['resolution.finalize', 'disclosure.open', 'results.publish']);
  const [secret, setSecret] = useState('');
  const load = useCallback(() => {
    void backend.listWebhooks!(pid).then(setHooks, fail);
    void backend.listWebhookDeliveries!(pid).then(setDeliveries, fail);
  }, [backend, pid, fail]);
  useEffect(load, [load]);
  const toggle = (e: string) => setEvents((x) => (x.includes(e) ? x.filter((y) => y !== e) : [...x, e]));
  return (
    <div className="card stack">
      <h2>Webhooks</h2>
      <p className="ink2" style={{ margin: 0 }}>
        Agreemetry sends a signed POST request to your address when a chosen event happens. The message carries the event name and identifiers only, never judgments, names or item content; fetch details through the API. Requests are signed with HMAC SHA-256 in the <code>X-Agreemetry-Signature</code> header. Sending needs the pg_net extension on the server; without it, deliveries are recorded below and in the events feed.
      </p>
      {secret && (
        <Notice tone="good">
          <div className="stack" style={{ gap: 6 }}>
            <strong>Signing secret. Copy it now; it is shown only once.</strong>
            <div className="secret">{secret}</div>
            <div className="row"><button className="btn sm" onClick={() => setSecret('')}>Done</button></div>
          </div>
        </Notice>
      )}
      {hooks.map((h) => (
        <div className="member-row" key={h.id}>
          <div className="who">
            <strong className="mono" style={{ overflowWrap: 'anywhere' }}>{h.url}</strong>
            <small>{h.active ? 'Active' : 'Paused'} · {h.events.length} {h.events.length === 1 ? 'event' : 'events'} · secret {h.secretPrefix}…</small>
          </div>
          <button className="btn sm" onClick={() => backend.saveWebhook!(pid, { id: h.id, url: h.url, events: h.events, active: !h.active }).then(load, fail)}>{h.active ? 'Pause' : 'Resume'}</button>
          <button className="btn sm" onClick={() => backend.saveWebhook!(pid, { id: h.id, url: h.url, events: h.events, active: h.active, rotateSecret: true }).then((r) => { if (r.secret) setSecret(r.secret); load(); }, fail)}>New secret</button>
          <button className="btn sm danger" onClick={() => { if (confirm('Delete this webhook?')) backend.deleteWebhook!(pid, h.id).then(load, fail); }}>Delete</button>
        </div>
      ))}
      <div className="stack" style={{ gap: 8 }}>
        <h3>Add a webhook</h3>
        <Field label="Address (https only)">
          <input type="url" placeholder="https://example.org/agreemetry-hook" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
          <legend className="small" style={{ fontWeight: 550, marginBottom: 4 }}>Events</legend>
          <div className="grid cols-2" style={{ gap: 4 }}>
            {WEBHOOK_EVENTS.map(([e, label]) => (
              <label key={e} className="check small"><input type="checkbox" checked={events.includes(e)} onChange={() => toggle(e)} />{label} <span className="mono muted">{e}</span></label>
            ))}
          </div>
        </fieldset>
        <div className="row end">
          <button className="btn primary" disabled={!url.startsWith('https://') || events.length === 0} onClick={() => backend.saveWebhook!(pid, { url: url.trim(), events, active: true }).then((r) => { setSecret(r.secret ?? ''); setUrl(''); toast('Webhook added.'); load(); }, fail)}>Add webhook</button>
        </div>
      </div>
      {deliveries.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <h3>Recent deliveries</h3>
          {deliveries.slice(0, 15).map((d) => (
            <div key={d.id} className="small mono" style={{ overflowWrap: 'anywhere' }}>
              #{d.id} {d.event} · {d.createdAt.slice(0, 19).replace('T', ' ')} · {d.queuedAt ? 'sent' : d.error ? `failed: ${d.error}` : 'recorded (no pg_net)'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
