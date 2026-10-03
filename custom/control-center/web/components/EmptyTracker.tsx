import { Link } from '@tanstack/react-router';

/** A new user's empty tracker (no file, or a header with no rows): an explanation and the next step, not an error. */
export function EmptyTracker({ nothingTo = 'show' }: { nothingTo?: string }) {
  return (
    <div className="card empty-state" role="status">
      <h2>No applications yet</h2>
      <p className="muted">There is nothing to {nothingTo} until the tracker has a row. Evaluate a job posting to add the first one.</p>
      <div className="row gap">
        <Link to="/" className="button-link">
          Evaluate a job on Today
        </Link>
        <Link to="/pipeline" className="button-link">
          Open the Pipeline
        </Link>
      </div>
    </div>
  );
}
