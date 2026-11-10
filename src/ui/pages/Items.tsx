import { useMemo, useState } from 'react';
import { useApp, type ProjectView } from '../app';
import { DataTable, Field, Icon, ItemText, Modal, Notice, STATE_LABEL, StateBadge, type Column } from '../components';
import { buildContexts, buildItems, parseFile, validateRows, type ColumnMapping, type ParsedTable, type ValidationReport } from '../../core/io/importer';
import { pseudonyms } from '../../core/analysis';
import type { Item, ItemState } from '../../core/types';

export function ItemsPage({ v }: { v: ProjectView }) {
  const { data } = v;
  const p = data.project;
  const [q, setQ] = useState('');
  const [batch, setBatch] = useState('');
  const [state, setState] = useState('');
  const [open, setOpen] = useState<Item | null>(null);
  const [importing, setImporting] = useState(false);
  const [ctxImport, setCtxImport] = useState(false);
  const titleOf = (i: Item) => (p.config.display.titleField && i.fields[p.config.display.titleField] ? String(i.fields[p.config.display.titleField]) : '');
  const batches = useMemo(() => [...new Set(data.items.map((i) => i.batch))].sort(), [data.items]);
  const needle = q.trim().toLowerCase();
  const rows = data.items.filter((i) => (!batch || i.batch === batch) && (!state || v.stateOf(i.id) === state) && (!needle || i.externalId.toLowerCase().includes(needle) || titleOf(i).toLowerCase().includes(needle) || (p.config.display.bodyField && String(i.fields[p.config.display.bodyField] ?? '').toLowerCase().includes(needle))));
  const columns: Column<Item>[] = [
    { key: 'id', label: 'Identifier', value: (i) => i.externalId, render: (i) => <span className="mono">{i.externalId}</span> },
    { key: 'title', label: 'Title', value: titleOf, render: (i) => <span>{titleOf(i).slice(0, 110)}</span> },
    { key: 'batch', label: 'Batch', value: (i) => i.batch },
    { key: 'state', label: 'Status', value: (i) => v.stateOf(i.id), render: (i) => <StateBadge state={v.stateOf(i.id)} /> },
    { key: 'sub', label: 'Judgments', num: true, value: (i) => v.statuses.get(i.id)?.submitted.length ?? 0, render: (i) => { const s = v.statuses.get(i.id); return s ? `${s.submitted.length} of ${s.required}` : ''; } },
    { key: 'seq', label: 'Order', num: true, value: (i) => i.seq },
  ];
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Items</h1>
          <p>Every imported field is kept unchanged. {p.config.display.blindedFields.length > 0 && `Blinded fields (${p.config.display.blindedFields.join(', ')}) are shown to administrators only.`}</p>
        </div>
        {v.isAdmin && (
          <>
            <button className="btn" onClick={() => setCtxImport(true)}>Import context documents</button>
            <button className="btn primary" onClick={() => setImporting(true)}><Icon name="upload" />Import items</button>
          </>
        )}
      </div>
      <div className="toolbar">
        <div className="grow"><input type="search" placeholder="Search identifiers, titles and text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search items" /></div>
        <select value={batch} onChange={(e) => setBatch(e.target.value)} aria-label="Batch" style={{ width: 'auto' }}>
          <option value="">All batches</option>
          {batches.map((b) => <option key={b}>{b}</option>)}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Status" style={{ width: 'auto' }}>
          <option value="">Any status</option>
          {(Object.keys(STATE_LABEL) as ItemState[]).map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
        </select>
        <span className="muted small num">{rows.length.toLocaleString()} of {data.items.length.toLocaleString()}</span>
      </div>
      <DataTable rows={rows} columns={columns} rowKey={(i) => i.id} onRow={setOpen} pageSize={30} empty="No items match." />
      {open && <ItemDetail v={v} item={open} onClose={() => setOpen(null)} />}
      {importing && <ImportWizard v={v} onClose={() => setImporting(false)} />}
      {ctxImport && <ContextImport v={v} onClose={() => setCtxImport(false)} />}
    </div>
  );
}

function ItemDetail({ v, item, onClose }: { v: ProjectView; item: Item; onClose: () => void }) {
  const { backend, toast, fail } = useApp();
  const p = v.data.project;
  const names = pseudonyms(v.data);
  const st = v.statuses.get(item.id);
  const as = v.data.assessments.filter((a) => a.itemId === item.id);
  const body = p.config.display.bodyField ? String(item.fields[p.config.display.bodyField] ?? '') : '';
  return (
    <Modal title={item.externalId} onClose={onClose} wide footer={<>
      {v.isAdmin && as.length === 0 && <button className="btn danger" onClick={() => { if (confirm('Delete this item? It has no judgments.')) backend.deleteItems(p.id, [item.id]).then(() => { toast('Deleted.'); onClose(); }, fail); }}>Delete item</button>}
      <a className="btn" href={`#/p/${p.id}/disagreements/${item.id}`} onClick={onClose}>Open resolution view</a>
      <button className="btn primary" onClick={onClose}>Close</button>
    </>}>
      <div className="grid cols-2">
        <div>
          <h3>Fields</h3>
          <dl className="fieldlist">
            <dt>batch</dt><dd>{item.batch}</dd>
            <dt>status</dt><dd>{st && <StateBadge state={st.state} />}</dd>
            {Object.entries(item.fields).filter(([k]) => k !== p.config.display.bodyField).map(([k, val]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}{p.config.display.blindedFields.includes(k) && <span className="badge neutral" style={{ marginLeft: 4 }}>blinded</span>}</dt>
                <dd>{typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')}</dd>
              </div>
            ))}
          </dl>
          {v.isAdmin && as.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Judgments (administrator view)</h3>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Adjudicator</th><th>Status</th><th>Values</th><th className="num">Version</th></tr></thead>
                  <tbody>{as.map((a) => <tr key={a.id}><td>{names.get(a.userId)}</td><td>{a.status}</td><td className="small mono">{JSON.stringify(a.values)}</td><td className="num">{a.version}</td></tr>)}</tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div>
          <h3>Text</h3>
          {body ? <ItemText text={body} /> : <p className="muted">No text field configured.</p>}
        </div>
      </div>
    </Modal>
  );
}

function ImportWizard({ v, onClose }: { v: ProjectView; onClose: () => void }) {
  const { backend, toast, fail } = useApp();
  const p = v.data.project;
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [map, setMap] = useState<ColumnMapping>({ idColumn: '', requiredColumns: [], defaultBatch: `import ${new Date().toISOString().slice(0, 10)}` });
  const [report, setReport] = useState<ValidationReport | null>(null);
  const existing = useMemo(() => new Set(v.data.items.map((i) => i.externalId)), [v.data.items]);
  async function load(f: File, sheet?: string) {
    try {
      const t = await parseFile(f, sheet);
      setFile(f);
      setTable(t);
      const guess = t.columns.find((c) => /^(id|item_?id|record|key|identifier)$/i.test(c)) ?? t.columns[0] ?? '';
      setMap((m) => ({ ...m, idColumn: guess }));
      setReport(null);
    } catch (e) {
      fail(e);
    }
  }
  const validate = () => table && setReport(validateRows(table, map, existing));
  const go = async () => {
    if (!table || !report) return;
    const items = buildItems(p.id, table, map, v.data.items.length, report);
    try {
      await backend.importItems(p.id, items);
      toast(`Imported ${items.length} items.`);
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  const cols = table?.columns ?? [];
  const display = p.config.display;
  return (
    <Modal title="Import items" onClose={onClose} wide footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn" disabled={!table || !map.idColumn} onClick={validate}>Validate</button>
      <button className="btn primary" disabled={!report || report.validRows === 0} onClick={() => void go()}>Import {report ? report.validRows.toLocaleString() : ''} valid rows</button>
    </>}>
      <div className="stack">
        <label className="btn" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
          <Icon name="upload" />{file ? file.name : 'Choose a CSV, Excel or JSON file'}
          <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,.ods,.json" hidden onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
        </label>
        {table?.sheets && table.sheets.length > 1 && (
          <Field label="Sheet">
            <select value={table.sheet} onChange={(e) => file && void load(file, e.target.value)}>{table.sheets.map((s) => <option key={s}>{s}</option>)}</select>
          </Field>
        )}
        {table && (
          <>
            <p className="small ink2">{table.rows.length.toLocaleString()} rows, {cols.length} columns. Every column is kept as an item field. The display settings expect <code>{display.titleField || '(none)'}</code> as title and <code>{display.bodyField || '(none)'}</code> as text; change them in Settings, Display, if your columns differ.</p>
            <div className="grid cols-3">
              <Field label="Identifier column" hint="Unique per item.">
                <select value={map.idColumn} onChange={(e) => setMap({ ...map, idColumn: e.target.value })}>{cols.map((c) => <option key={c}>{c}</option>)}</select>
              </Field>
              <Field label="Batch column (optional)">
                <select value={map.batchColumn ?? ''} onChange={(e) => setMap({ ...map, batchColumn: e.target.value || undefined })}><option value="">None: use the default batch</option>{cols.map((c) => <option key={c}>{c}</option>)}</select>
              </Field>
              <Field label="Category column (optional)">
                <select value={map.categoryColumn ?? ''} onChange={(e) => setMap({ ...map, categoryColumn: e.target.value || undefined })}><option value="">None</option>{cols.map((c) => <option key={c}>{c}</option>)}</select>
              </Field>
            </div>
            {!map.batchColumn && <Field label="Default batch"><input type="text" value={map.defaultBatch} onChange={(e) => setMap({ ...map, defaultBatch: e.target.value })} /></Field>}
            <div className="field">
              <span style={{ fontWeight: 550 }}>Columns that must not be empty</span>
              <div className="row">{cols.map((c) => (
                <label key={c} className="check small"><input type="checkbox" checked={map.requiredColumns.includes(c)} onChange={(e) => setMap({ ...map, requiredColumns: e.target.checked ? [...map.requiredColumns, c] : map.requiredColumns.filter((x) => x !== c) })} />{c}</label>
              ))}</div>
            </div>
            <h3>Preview</h3>
            <div className="table-wrap" style={{ maxHeight: 220 }}>
              <table className="data"><thead><tr>{cols.slice(0, 8).map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{table.rows.slice(0, 5).map((r, i) => <tr key={i}>{cols.slice(0, 8).map((c) => <td key={c} className="small">{String(r[c] ?? '').slice(0, 80)}</td>)}</tr>)}</tbody></table>
            </div>
          </>
        )}
        {report && (
          <div className="stack">
            {report.issues.filter((x) => x.level === 'error').length === 0 ? <Notice tone="good">All {report.validRows.toLocaleString()} rows are valid.</Notice> : (
              <Notice tone="warn">
                {report.validRows.toLocaleString()} valid rows. {report.duplicateIds.length} duplicate identifiers, {report.existingIds.length} already in the project, {report.missingIds} missing identifiers, {report.emptyRequired} empty required values. Rows with errors are skipped.
              </Notice>
            )}
            {report.issues.length > 0 && (
              <div className="table-wrap" style={{ maxHeight: 240 }}>
                <table className="data"><thead><tr><th className="num">Row</th><th>Column</th><th>Level</th><th>Issue</th></tr></thead>
                  <tbody>{report.issues.slice(0, 200).map((x, i) => <tr key={i}><td className="num">{x.row || 'file'}</td><td>{x.column}</td><td>{x.level}</td><td>{x.message}</td></tr>)}</tbody></table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ContextImport({ v, onClose }: { v: ProjectView; onClose: () => void }) {
  const { backend, toast, fail } = useApp();
  const [t, setT] = useState<ParsedTable | null>(null);
  const [keys, setKeys] = useState({ key: '', title: '', body: '' });
  return (
    <Modal title="Import context documents" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!t || !keys.key || !keys.body} onClick={() => {
        const docs = buildContexts(v.data.project.id, t!, keys.key, keys.title || keys.key, keys.body);
        backend.importItems(v.data.project.id, [], docs).then(() => { toast(`Imported ${docs.length} context documents.`); onClose(); }, fail);
      }}>Import</button>
    </>}>
      <div className="stack">
        <p className="ink2 small">Context documents are shared reference texts (a case description, a protocol, a source) shown beside every item whose field <code>{v.data.project.config.display.contextKeyField || '(set the context key field in Settings, Display)'}</code> matches the document key. Upload a table with a key column, an optional title column and a body column (markdown allowed).</p>
        <label className="btn" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}><Icon name="upload" />Choose file<input type="file" hidden accept=".csv,.xlsx,.json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) try { const x = await parseFile(f); setT(x); setKeys({ key: x.columns[0] ?? '', title: x.columns[1] ?? '', body: x.columns[2] ?? '' }); } catch (err) { fail(err); } }} /></label>
        {t && (['key', 'title', 'body'] as const).map((k) => (
          <Field key={k} label={`${k} column`}><select value={keys[k]} onChange={(e) => setKeys({ ...keys, [k]: e.target.value })}><option value="">None</option>{t.columns.map((c) => <option key={c}>{c}</option>)}</select></Field>
        ))}
      </div>
    </Modal>
  );
}
