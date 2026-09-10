type User = { id: string; email: string };
type AccessClaims = { sub?: string; email?: string; aud?: string | string[]; iss?: string; exp?: number };
let jwksCache: { host: string; expires: number; keys: JsonWebKey[] } | null = null;

function decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function saveUser(env: Env, subject: string, email: string): Promise<User> {
  await env.DB.prepare('INSERT INTO users (id, auth_subject, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(auth_subject) DO UPDATE SET email=excluded.email')
    .bind(crypto.randomUUID(), subject, email, new Date().toISOString()).run();
  return (await env.DB.prepare('SELECT id, email FROM users WHERE auth_subject = ?').bind(subject).first<User>())!;
}

export async function resolveUser(request: Request, env: Env): Promise<User | null> {
  const team: string = env.ACCESS_TEAM_DOMAIN as string;
  const devEmail = (env as Env & { DEV_USER_EMAIL?: string }).DEV_USER_EMAIL;
  if (!team) return devEmail ? saveUser(env, `dev:${devEmail}`, devEmail) : null;
  const host = team.endsWith('.cloudflareaccess.com') ? team : `${team}.cloudflareaccess.com`;
  if (!/^[a-z0-9.-]+\.cloudflareaccess\.com$/i.test(host)) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion'), parts = token?.split('.');
  if (!parts || parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0]))) as { alg?: string; kid?: string };
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1]))) as AccessClaims;
    if (header.alg !== 'RS256' || !header.kid || !claims.sub || !claims.email || !claims.exp || claims.exp * 1000 <= Date.now()
      || claims.iss !== `https://${host}` || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(env.ACCESS_AUD)) return null;
    if (!jwksCache || jwksCache.host !== host || jwksCache.expires < Date.now()) {
      const response = await fetch(`https://${host}/cdn-cgi/access/certs`);
      if (!response.ok) return null;
      const body = await response.json<{ keys: JsonWebKey[] }>();
      jwksCache = { host, keys: body.keys, expires: Date.now() + 3_600_000 };
    }
    const jwk = jwksCache.keys.find(key => (key as JsonWebKey & { kid?: string }).kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return valid ? saveUser(env, claims.sub, claims.email) : null;
  } catch { return null; }
}
