/** The recovery page's own styles, after PAGE_THEME_CSS (whose tokens they use). Its own module, so it is tested in a DOM. */
export const RECOVERY_CSS = `
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,Inter,sans-serif;margin:0;padding:24px;max-width:960px}
h1{font-size:22px}h2{font-size:16px;margin-top:32px}h3{font-size:14px}a{color:var(--accent)}code,pre{font-family:ui-monospace,Menlo,monospace;font-size:12px}
pre{background:var(--surface-1);border:1px solid var(--border);border-radius:6px;padding:8px;overflow:auto;max-height:320px}
.s{color:var(--text-muted)}button{background:var(--surface-2);color:var(--text);border:1px solid var(--border-strong);border-radius:6px;padding:4px 10px;min-height:32px;cursor:pointer}
button:disabled{color:var(--text-muted);opacity:.55;cursor:not-allowed}
form{display:inline-block;margin:0 8px}li{margin:6px 0}.status{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:12px}
#revert-status{margin:12px 0}.status p{margin:8px 0}.status pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden}#revert-status details{margin-top:6px}#revert-status pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden}
`;
