import { lastSession } from './lastSession';

// The last Dev Chat session of this browser tab, so /dev with no ?session= (the sidebar link, the reload banner)
// reopens it.
const devchat = lastSession('cc.devchat.session');

export const readLastDevSession = devchat.read;
export const writeLastDevSession = devchat.write;
/** A deleted session is not reopened: called when the Sessions page deletes one. */
export const forgetDevSession = devchat.forget;
