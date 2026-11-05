export function ProgressBar({ percent, label }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Course progress'}>
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Loading() {
  return <p className="muted" role="status">Loading…</p>;
}

export function ErrorNote({ children }) {
  return <p className="error-note" role="alert">{children}</p>;
}

export function PageTitle({ title, subtitle }) {
  return (
    <div className="page-title">
      <h1>{title}</h1>
      {subtitle && <p className="muted">{subtitle}</p>}
    </div>
  );
}
