const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export function assertTenantId(id: string): string {
  if (!TENANT_RE.test(id)) throw new Error(`Invalid tenant id "${id}" (lowercase letters, digits, dashes)`);
  return id;
}

export function assertVersion(v: string): string {
  if (!VERSION_RE.test(v) || v.includes('..')) throw new Error(`Invalid base version "${v}"`);
  return v;
}

export const refs = {
  main: 'refs/heads/main',
  base: (version: string) => `refs/tags/base/${assertVersion(version)}`,
  tenant: (tenantId: string) => `refs/heads/tenants/${assertTenantId(tenantId)}`,
} as const;
