/**
 * Stylesheet for the 「MCP 服务器」 settings page (v2 layout).
 * @module dsh-mcp-hub/src/client/styles
 */

const STYLE_ID = 'dsh-mcp-hub-style'

/** The whole stylesheet. */
export const CSS = `
.dmhb { display: flex; flex-direction: column; gap: 16px; padding: 2px 0 28px; max-width: 820px; font-size: 13px; }
.dmhb-intro { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #777); line-height: 1.65; margin: 0; }

.dmhb-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2));
  border-radius: 12px; padding: 14px 16px 16px;
  display: flex; flex-direction: column; gap: 12px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03));
}
.dmhb-card > h3 { margin: 0; font-size: 13.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.dmhb-card > h3 .dmhb-count { font-weight: 400; font-size: 12px; color: var(--dsw-alias-label-secondary, #888); }

/* ---- status strip ---- */
.dmhb-strip { display: flex; gap: 8px; flex-wrap: wrap; }
.dmhb-chip {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
  padding: 5px 11px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05));
  color: var(--dsw-alias-label-secondary, #777); max-width: 100%;
}
.dmhb-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.dmhb-dot-ok { background: var(--dsw-alias-state-success-primary, #2a2); }
.dmhb-dot-warn { background: var(--dsw-alias-state-warn-primary, #c80); }
.dmhb-dot-bad { background: var(--dsw-alias-state-error-primary, #d33); }
.dmhb-chip strong { color: var(--dsw-alias-label-primary, #111); font-weight: 600; }
.dmhb-chip .dmhb-mono { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmhb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; word-break: break-all; }

/* ---- catalog grid ---- */
.dmhb-cat { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.dmhb-tile {
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2));
  border-radius: 11px; padding: 12px 13px; text-align: left; cursor: pointer;
  display: flex; flex-direction: column; gap: 6px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03));
  color: inherit; font: inherit; transition: border-color .12s ease, transform .12s ease;
}
.dmhb-tile:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4d6bfe); transform: translateY(-1px); }
.dmhb-tile:disabled { opacity: .55; cursor: default; }
.dmhb-tile-head { display: flex; align-items: center; gap: 8px; }
.dmhb-tile-icon { font-size: 18px; line-height: 1; }
.dmhb-tile-name { font-weight: 600; font-size: 13px; flex: 1 1 auto; min-width: 0; }
.dmhb-tile-badge { font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
  background: var(--dsw-alias-state-success-primary, #2a2); color: #fff; white-space: nowrap; }
.dmhb-tile-summary { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #888); line-height: 1.5; }
.dmhb-tile-note { font-size: 11px; color: var(--dsw-alias-state-warn-primary, #c80); }

/* ---- server list ---- */
.dmhb-list { display: flex; flex-direction: column; gap: 8px; }
.dmhb-server {
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2)); border-radius: 11px; padding: 11px 13px;
  display: flex; flex-direction: column; gap: 7px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03));
}
.dmhb-server-on { border-color: var(--dsw-alias-state-success-primary, #2a2); }
.dmhb-server-off { opacity: .6; }
.dmhb-server-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dmhb-server-name { font-weight: 600; font-size: 13px; }
.dmhb-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(127,127,127,0.14);
  color: var(--dsw-alias-label-secondary, #777); white-space: nowrap; }
.dmhb-badge-on { background: var(--dsw-alias-state-success-primary, #2a2); color: #fff; }
.dmhb-badge-http { background: rgba(77,107,254,.14); color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dmhb-server-target { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #888);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmhb-problem { font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #d33); word-break: break-word; }

/* ---- form ---- */
.dmhb-form { display: flex; flex-direction: column; gap: 11px; }
.dmhb-row { display: flex; align-items: center; gap: 12px; min-height: 28px; }
.dmhb-row > .dmhb-label { flex: 0 0 118px; font-size: 12.5px; }
.dmhb-row > .dmhb-control { flex: 1 1 auto; display: flex; align-items: center; gap: 10px; min-width: 0; }
.dmhb-label { font-size: 12.5px; }
.dmhb-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #8a8a8a); line-height: 1.5; }
.dmhb-input, .dmhb-area, .dmhb-select {
  font: inherit; font-size: 12.5px; padding: 6px 10px; border-radius: 8px; color: inherit; width: 100%; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06));
}
.dmhb-select { max-width: 250px; width: auto; }
.dmhb-input:focus, .dmhb-area:focus, .dmhb-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dmhb-area { min-height: 64px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.5; }
.dmhb-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; user-select: none; }
.dmhb-switch input { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary, #4d6bfe); margin: 0; cursor: pointer; }

/* ---- buttons ---- */
.dmhb-btn {
  appearance: none; font: inherit; font-size: 12.5px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.05)); color: inherit; white-space: nowrap;
}
.dmhb-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dmhb-btn:disabled { opacity: .5; cursor: default; }
.dmhb-btn-primary { background: var(--dsw-alias-label-primary, #111); color: var(--dsw-alias-bg-base, #fff); border-color: transparent; }
.dmhb-btn-danger { color: var(--dsw-alias-state-error-primary, #d33); }
.dmhb-link { appearance: none; border: none; background: none; color: var(--dsw-alias-brand-primary, #4d6bfe);
  cursor: pointer; font: inherit; font-size: 12px; padding: 0; text-decoration: underline; }
.dmhb-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

/* ---- misc ---- */
.dmhb-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(127,127,127,.3);
  border-top-color: var(--dsw-alias-brand-primary, #4d6bfe); animation: dmhb-spin .7s linear infinite; }
@keyframes dmhb-spin { to { transform: rotate(360deg); } }
.dmhb-empty { text-align: center; color: var(--dsw-alias-label-secondary, #999); font-size: 12.5px; padding: 22px 10px; }
.dmhb-tools { display: flex; flex-direction: column; gap: 6px; max-height: 250px; overflow: auto; }
.dmhb-tool { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18)); border-radius: 8px; padding: 7px 10px;
  display: flex; flex-direction: column; gap: 2px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03)); }
.dmhb-tool code { font-size: 12px; font-weight: 600; }
.dmhb-tool span { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #888); }
.dmhb-status { font-size: 12px; min-height: 18px; }
.dmhb-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #d33); word-break: break-word; }
.dmhb-ok { color: var(--dsw-alias-state-success-primary, #2a2); }
.dmhb-cred { display: flex; gap: 8px; align-items: center; }
.dmhb-cred .dmhb-input { flex: 1 1 auto; }
`

/** Inject the stylesheet once; safe to call on every apply(). */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = CSS
  document.head.appendChild(element)
}
