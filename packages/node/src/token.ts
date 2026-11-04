/** Compact HMAC-SHA256 tokens (JWT-shaped, HS256). WebCrypto only, so it runs in Node, Workers and edge runtimes. */

export type TokenClaims = {
  /** Token purpose. "editor" = open the editor; "preview" = view an unpublished release. */
  typ: 'editor' | 'preview';
  /** Tenant id. */
  t: string;
  /** End-user id (optional). */
  u?: string;
  /** Editor: may customize. */
  c?: boolean;
  /** Preview: release id. */
  r?: string;
  /** Expiry, seconds since epoch. */
  exp: number;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keys = new Map<string, Promise<HmacKey>>();
function key(secret: string): Promise<HmacKey> {
  if (secret.length < 32) throw new Error('FORKUI_SECRET must be at least 32 characters');
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.set(secret, k);
  }
  return k;
}

const HEADER = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

export async function signToken(claims: Omit<TokenClaims, 'exp'> & { exp?: number }, secret: string, ttlSeconds = 900): Promise<string> {
  const body: TokenClaims = { ...claims, exp: claims.exp ?? Math.floor(Date.now() / 1000) + ttlSeconds } as TokenClaims;
  const payload = b64url(enc.encode(JSON.stringify(body)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(`${HEADER}.${payload}`)));
  return `${HEADER}.${payload}.${b64url(sig)}`;
}

/** Returns the claims if the signature is valid, the token is unexpired and (optionally) of the expected type. */
export async function verifyToken(token: string, secret: string, typ?: TokenClaims['typ']): Promise<TokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(parts[2]!), enc.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  let claims: TokenClaims;
  try {
    claims = JSON.parse(dec.decode(fromB64url(parts[1]!)));
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
  if (typeof claims.t !== 'string' || !claims.t) return null;
  if (typ && claims.typ !== typ) return null;
  return claims;
}
