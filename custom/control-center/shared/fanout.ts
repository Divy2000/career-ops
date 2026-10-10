/** The most URLs one POST /api/sessions/fanout takes: the route refuses more, and Pipeline > Batch and Inbox > Evaluate visible stop at it. */
export const BATCH_MAX_URLS = 50;
/** Above this many evaluations, starting a fan-out asks "Start N evaluation sessions?" first (Evaluate visible, the Ask drawer). */
export const FANOUT_CONFIRM_ABOVE = 3;
