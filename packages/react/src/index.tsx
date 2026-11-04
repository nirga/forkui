import { useEffect, useState, type CSSProperties } from 'react';

type Session = { token: string; editorUrl: string };
type Status = { tenantId: string | null; release: string | null; preview: boolean };

export type CustomizeProps = {
  /** Where the forkui middleware is mounted. Default "/_forkui". */
  basePath?: string;
  /** Button label. */
  label?: string;
  /** Corner for the floating button. Default: the corner away from the reading start (left for RTL pages). */
  position?: 'bottom-right' | 'bottom-left';
  /** The UI language of your app (e.g. i18n.language). Default: <html lang>. */
  language?: string;
};

const z = 2147483000;
const OPEN_KEY = 'forkui:open';
const btn: CSSProperties = {
  position: 'fixed',
  bottom: 20,
  zIndex: z,
  padding: '10px 16px',
  borderRadius: 999,
  border: 'none',
  background: '#111827',
  color: '#fff',
  font: '600 14px system-ui, sans-serif',
  boxShadow: '0 4px 14px rgba(0,0,0,.25)',
  cursor: 'pointer',
};

/**
 * Render once in your app root. Shows nothing unless the forkui middleware says the current
 * user may customize (your `canCustomize`), or they're previewing an unpublished change.
 */
export function Customize({ basePath = '/_forkui', label = 'Customize', position, language }: CustomizeProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  // Stay open across the reloads that preview / publish cause.
  const [open, setOpenState] = useState(() => {
    try {
      return sessionStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      if (v) sessionStorage.setItem(OPEN_KEY, '1');
      else sessionStorage.removeItem(OPEN_KEY);
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    let cancelled = false;
    const get = (p: string) =>
      fetch(`${basePath}/${p}`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    void get('token').then((s: Session | null) => !cancelled && setSession(s));
    void get('status').then((s: Status | null) => !cancelled && setStatus(s));
    return () => {
      cancelled = true;
    };
  }, [basePath]);

  useEffect(() => {
    if (!session) return;
    const editorOrigin = new URL(session.editorUrl).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== editorOrigin || typeof e.data !== 'object' || !e.data) return;
      if (e.data.type === 'forkui:preview' && typeof e.data.grant === 'string')
        window.location.href = `${basePath}/preview?grant=${encodeURIComponent(e.data.grant)}`;
      else if (e.data.type === 'forkui:exit-preview') window.location.href = `${basePath}/preview/exit`;
      else if (e.data.type === 'forkui:reload') window.location.reload();
      else if (e.data.type === 'forkui:close') setOpen(false);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session, basePath]);

  const rtl = (document.dir || document.body.dir) === 'rtl';
  const side = (position ?? (rtl ? 'bottom-left' : 'bottom-right')) === 'bottom-left' ? { left: 20 } : { right: 20 };
  return (
    <>
      {status?.preview && (
        <div
          role="status"
          style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: z, padding: '6px 12px', background: '#6941c6', color: '#fff', font: '500 13px system-ui, sans-serif', textAlign: 'center' }}
        >
          You are previewing an unpublished customization. Only you can see it.{' '}
          {session && !open && (
            <button type="button" onClick={() => setOpen(true)} style={{ background: '#fff', color: '#6941c6', border: 'none', borderRadius: 6, padding: '2px 8px', font: '600 12px system-ui', cursor: 'pointer', marginRight: 8 }}>
              Publish or discard…
            </button>
          )}
          <a href={`${basePath}/preview/exit`} style={{ color: '#fff', textDecoration: 'underline' }}>
            Exit preview
          </a>
        </div>
      )}
      {session && !open && (
        <button type="button" style={{ ...btn, ...side }} onClick={() => setOpen(true)} data-forkui-id="customize-button">
          {label}
        </button>
      )}
      {session && open && (
        <div style={{ position: 'fixed', top: status?.preview ? 30 : 0, bottom: 0, ...side, width: 'min(440px, 100vw)', zIndex: z, boxShadow: '0 0 32px rgba(0,0,0,.3)', background: '#fff' }}>
          <iframe
            title="Customize"
            src={`${session.editorUrl}#token=${encodeURIComponent(session.token)}&origin=${encodeURIComponent(window.location.origin)}${status?.preview ? '&preview=1' : ''}&lang=${encodeURIComponent(language ?? document.documentElement.lang ?? '')}&dir=${document.dir || document.body.dir || 'ltr'}`}
            style={{ border: 'none', width: '100%', height: '100%' }}
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      )}
    </>
  );
}
