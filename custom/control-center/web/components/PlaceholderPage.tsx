export function PlaceholderPage({ title }: { title: string }) {
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">{title}</h1>
      </div>
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          This page lands in a later build phase. Nothing here reads or writes your data yet.
        </p>
      </div>
    </section>
  );
}
