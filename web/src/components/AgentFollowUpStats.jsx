import { useMemo, useState } from 'react';

const DAY = 86_400_000;
const dayOf = (iso) => iso.slice(0, 10);
const RANGES = { Today: 1, '1W': 7, '2W': 14, '1M': 30 };
const COLORS = { sent: '#6b7280', opened: '#5624d0', cameBack: '#1e9e6a' };

export function Ring({ label, part, whole }) {
  const pct = whole ? Math.round((part / whole) * 100) : 0;
  const r = 40;
  const c = 2 * Math.PI * r;
  return (
    <figure className="card" style={{ textAlign: 'center', margin: 0, padding: 12 }}>
      <svg width="110" height="110" viewBox="0 0 110 110" role="img" aria-label={`${label}: ${part} of ${whole}, ${pct}%`}>
        <circle cx="55" cy="55" r={r} fill="none" stroke="#e5e7eb" strokeWidth="12" />
        <circle cx="55" cy="55" r={r} fill="none" stroke="#5624d0" strokeWidth="12" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 55 55)" />
        <text x="55" y="61" textAnchor="middle" fontSize="18">{pct}%</text>
      </svg>
      <figcaption>{label}<br /><span className="muted small">{part} of {whole}</span></figcaption>
    </figure>
  );
}

export function DailyChart({ messages, now }) {
  const [range, setRange] = useState('2W');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const days = useMemo(() => {
    const end = range === 'Custom' && to ? Date.parse(to) : Date.parse(dayOf(now));
    const start = range === 'Custom' && from ? Date.parse(from) : end - ((RANGES[range] ?? 14) - 1) * DAY;
    const count = (key, d) => messages.filter((m) => m[key] && dayOf(m[key]) === d).length;
    const list = [];
    for (let t = start; t <= end && list.length < 366; t += DAY) {
      const d = new Date(t).toISOString().slice(0, 10);
      list.push({ d, sent: count('createdAt', d), opened: count('readAt', d), cameBack: count('cameBackAt', d) });
    }
    return list;
  }, [messages, now, range, from, to]);
  const max = Math.max(1, ...days.flatMap((x) => [x.sent, x.opened, x.cameBack]));
  const width = Math.max(300, days.length * 26);
  const bar = (v) => (v / max) * 110;
  return (
    <section className="card" style={{ padding: 12 }}>
      <div className="row" role="group" aria-label="Range">
        {[...Object.keys(RANGES), 'Custom'].map((r) => (
          <button key={r} type="button" className={`button small ${range === r ? 'dark' : 'ghost'}`} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>
        ))}
        {range === 'Custom' && (
          <>
            <label className="small">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="small">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg width={width} height="140" role="img" aria-label="Daily sent, opened and came back">
          {days.map((x, i) => (
            <g key={x.d} transform={`translate(${i * 26},0)`}>
              <rect x="2" y={120 - bar(x.sent)} width="6" height={bar(x.sent)} fill={COLORS.sent}><title>{`${x.d}: ${x.sent} sent`}</title></rect>
              <rect x="9" y={120 - bar(x.opened)} width="6" height={bar(x.opened)} fill={COLORS.opened}><title>{`${x.d}: ${x.opened} opened`}</title></rect>
              <rect x="16" y={120 - bar(x.cameBack)} width="6" height={bar(x.cameBack)} fill={COLORS.cameBack}><title>{`${x.d}: ${x.cameBack} came back`}</title></rect>
              <text x="12" y="135" textAnchor="middle" fontSize="9">{x.d.slice(8)}</text>
            </g>
          ))}
        </svg>
      </div>
      <p className="small muted">
        {Object.entries({ Sent: COLORS.sent, Opened: COLORS.opened, 'Came back': COLORS.cameBack }).map(([k, c]) => (
          <span key={k} style={{ marginRight: 12 }}><span style={{ display: 'inline-block', width: 10, height: 10, background: c, marginRight: 4 }} />{k}</span>
        ))}
      </p>
    </section>
  );
}

const BUCKETS = [['on_time', 'On time'], ['at_risk', 'At risk'], ['overdue', 'Overdue']];

function tally(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r[key]) ?? { on_time: 0, at_risk: 0, overdue: 0 };
    g[r.bucket] += 1;
    groups.set(r[key], g);
  }
  return [...groups.entries()];
}

export function DeadlineView({ rows }) {
  const [group, setGroup] = useState('organization');
  const table = (entries, head) => (
    <table className="table">
      <thead><tr><th>{head}</th>{BUCKETS.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
      <tbody>{entries.map(([name, g]) => <tr key={name}><td>{name}</td>{BUCKETS.map(([k]) => <td key={k}>{g[k]}</td>)}</tr>)}</tbody>
    </table>
  );
  return (
    <section>
      <h2 className="h3">Required training by deadline</h2>
      <label className="small">Group by{' '}
        <select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="organization">Account</option>
          <option value="department">Team</option>
          <option value="manager">Manager</option>
        </select>
      </label>
      {table(tally(rows, group).sort((a, b) => b[1].overdue - a[1].overdue || String(a[0]).localeCompare(String(b[0]))), 'Group')}
      <h3 className="h3">Trend per deadline</h3>
      {table(tally(rows, 'dueDate').sort((a, b) => a[0].localeCompare(b[0])), 'Due date')}
    </section>
  );
}