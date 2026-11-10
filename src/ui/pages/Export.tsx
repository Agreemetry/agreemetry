import { useCallback, useEffect, useState } from 'react';
import { useApp, type ProjectView } from '../app';
import { Field, Icon, Notice, download } from '../components';
import { archiveOf, buildTables, codebook, excelExport, jsonExport, tableCsv, zipExport, type Table } from '../../core/io/exporter';
import { slug } from '../../core/util';
import { adjudicators } from '../../core/workflow';
import { LocalBackend } from '../../data/localBackend';
import type { AssessmentPackage, ResultSnapshot } from '../../data/backend';

export function ExportPage({ v }: { v: ProjectView }) {
  const { backend, toast, fail } = useApp();
  const { data } = v;
  const p = data.project;
  const [names, setNames] = useState(false);
  const [reps, setReps] = useState(1000);
  const [tables, setTables] = useState<Table[] | null>(null);
  const [busy, setBusy] = useState('');
  const base = `${slug(p.shortName ?? p.name)}_${new Date().toISOString().slice(0, 10)}`;
  const opts = { includeNames: names, bootstrapReps: reps };
  const run = async (label: string, fn: () => Promise<void> | void) => {
    setBusy(label);
    await new Promise((r) => setTimeout(r, 20));
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  };
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Export</h1>
          <p>Analysis-ready, tidy datasets for R, Python, Stata or SPSS: UTF-8 CSV with a data dictionary and codebook. Independent judgments, agreement status and final classifications are separate tables. Adjudicators appear by project pseudonym unless you include names.</p>
        </div>
        <a className="btn" href={`#/p/${p.id}/report`}><Icon name="print" />Report (PDF)</a>
      </div>
      <div className="card stack">
        <div className="row">
          <label className="check"><input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} />Include display names next to pseudonyms</label>
          <Field label="Bootstrap resamples for intervals">
            <select value={reps} onChange={(e) => setReps(Number(e.target.value))} style={{ width: 'auto' }}>{[500, 1000, 2000, 5000].map((r) => <option key={r} value={r}>{r.toLocaleString()}</option>)}</select>
          </Field>
        </div>
        <div className="row">
          <button className="btn primary" disabled={!!busy} onClick={() => run('zip', async () => download(`${base}_agreemetry.zip`, await zipExport(data, opts)))}><Icon name="export" />{busy === 'zip' ? 'Preparing' : 'Complete archive (ZIP)'}</button>
          <button className="btn" disabled={!!busy} onClick={() => run('xlsx', async () => download(`${base}.xlsx`, await excelExport(data, opts)))}>{busy === 'xlsx' ? 'Preparing' : 'Excel workbook'}</button>
          <button className="btn" disabled={!!busy} onClick={() => run('json', () => download(`${base}.json`, jsonExport(data, opts)))}>JSON tables</button>
          <button className="btn" disabled={!!busy} onClick={() => run('arch', () => download(`${base}.agreemetry.json`, new Blob([JSON.stringify(archiveOf(data))], { type: 'application/json' })))}>Project archive (re-importable)</button>
          <button className="btn" onClick={() => download(`${base}_codebook.md`, new Blob([codebook(data)], { type: 'text/markdown' }))}>Codebook</button>
        </div>
        <p className="small muted">The ZIP holds every table below, the configuration, the codebook, the re-importable archive and loader scripts for R, Python and Stata.</p>
      </div>
      <div className="card">
        <div className="card-head">
          <h2 className="grow">Datasets</h2>
          <button className="btn sm" disabled={!!busy} onClick={() => run('tables', () => setTables(buildTables(data, opts).tables))}>{tables ? 'Refresh' : 'Prepare preview'}</button>
        </div>
        {!tables ? <p className="muted small">Prepare the preview to download tables one at a time.</p> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Table</th><th>Contents</th><th className="num">Rows</th><th className="num">Columns</th><th></th></tr></thead>
              <tbody>{tables.map((t) => (
                <tr key={t.name}><td className="mono">{t.name}.csv</td><td className="small" style={{ maxWidth: 520 }}>{t.description}</td><td className="num">{t.rows.length.toLocaleString()}</td><td className="num">{t.columns.length}</td>
                  <td><button className="btn sm" onClick={() => download(`${base}_${t.name}.csv`, new Blob([tableCsv(t)], { type: 'text/csv;charset=utf-8' }))}>CSV</button></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      {backend.publishResults && v.isAdmin && <PublishResults v={v} opts={opts} />}
      {backend instanceof LocalBackend && (
        <div className="card stack">
          <h2>Adjudicator packages (working without a shared server)</h2>
          <p className="ink2 small">Send each adjudicator a package holding only their assigned items, without blinded fields and without anyone else's judgments. They open it in Agreemetry on their own machine, rate, and send back their judgments file, which you import here. Submitted judgments already present are never overwritten.</p>
          <div className="row">
            {adjudicators(data.memberships).map((m) => (
              <button key={m.userId} className="btn" onClick={() => backend.exportAdjudicatorPackage(p.id, m.userId).then((a) => download(`${base}_package_${m.pseudonym}.json`, new Blob([JSON.stringify(a)], { type: 'application/json' })), fail)}>Package for {m.pseudonym}</button>
            ))}
          </div>
          <label className="btn" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
            <Icon name="upload" />Import returned judgments
            <input type="file" hidden accept=".json" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const pkg = JSON.parse(await f.text()) as AssessmentPackage;
                const r = await backend.importAssessmentPackage(p.id, pkg);
                toast(`Imported ${r.added} judgments from ${pkg.pseudonym}; skipped ${r.skipped}.`);
              } catch (err) {
                fail(err);
              }
            }} />
          </label>
          <Notice tone="info">In a package, the adjudicator's browser applies the blinding; in the shared server deployment the server does. Record which mode you used in the methods.</Notice>
        </div>
      )}
    </div>
  );
}

/** Tables published for the API: computed here, by the same code as the downloads, then stored as a versioned snapshot. */
const PUBLISHED_TABLES = ['final_classifications', 'agreement', 'outstanding', 'reliability', 'reliability_pairwise', 'reference_comparison', 'data_dictionary'];

function PublishResults({ v, opts }: { v: ProjectView; opts: { includeNames: boolean; bootstrapReps: number } }) {
  const { backend, toast, fail } = useApp();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [snaps, setSnaps] = useState<ResultSnapshot[]>([]);
  const pid = v.data.project.id;
  const load = useCallback(() => void backend.listResultSnapshots?.(pid).then(setSnaps, fail), [backend, pid, fail]);
  useEffect(load, [load]);
  async function publish() {
    setBusy(true);
    await new Promise((r) => setTimeout(r, 20));
    try {
      const { tables } = buildTables(v.data, { ...opts, includeNames: false });
      const out = Object.fromEntries(tables.filter((t) => PUBLISHED_TABLES.includes(t.name)).map((t) => [t.name, t.rows]));
      const r = await backend.publishResults!(pid, out, note);
      toast(`Published results snapshot ${r.id}.`);
      setNote('');
      load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card stack">
      <h2>Publish results to the API</h2>
      <p className="ink2 small" style={{ margin: 0 }}>
        Stores the final classifications, agreement, outstanding items, reliability and the data dictionary as a dated snapshot that tokens can read with <code>api_results</code>. Nothing is published automatically: you decide when results are ready. Adjudicators appear by pseudonym. The last ten snapshots are kept.
      </p>
      <div className="row">
        <input type="text" aria-label="Note" placeholder="Note, for example: after round 1 resolution" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 260px' }} />
        <button className="btn primary" disabled={busy} onClick={() => void publish()}>{busy ? 'Publishing' : 'Publish snapshot'}</button>
      </div>
      {snaps.length > 0 && (
        <div className="small">
          {snaps.map((s) => <div key={s.id} className="mono">#{s.id} · {s.publishedAt.slice(0, 16).replace('T', ' ')} · {s.by ?? ''}{s.note ? ` · ${s.note}` : ''}</div>)}
        </div>
      )}
    </div>
  );
}
