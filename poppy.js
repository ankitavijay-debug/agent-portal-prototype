// Poppy (Personal Agent Protocol 1.0) session verification, company side. Zero dependencies.
// Scope: verifies the Poppy-Session header (delegation JWT + session JWT). OAuth sign-in is NOT implemented;
// instead a verified session is mapped to a registered agent and a linked user (see cfg.poppy).
const crypto = require('crypto');

const b64u = (s) => Buffer.from(s, 'base64url');
const ALGS = {
  ES256: { hash: 'sha256', kty: 'EC', opts: { dsaEncoding: 'ieee-p1363' } },
  PS384: { hash: 'sha384', kty: 'RSA', opts: { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } },
};
function parse(jwt) {
  const p = String(jwt || '').split('.');
  if (p.length !== 3) throw new Error('malformed JWT');
  const j = (x) => JSON.parse(b64u(x).toString());
  return { header: j(p[0]), payload: j(p[1]), sig: b64u(p[2]), input: p[0] + '.' + p[1] };
}
function verifySig(t, jwk) {
  const a = ALGS[t.header.alg];
  if (!a) throw new Error(`unsupported alg ${t.header.alg}`);
  if (jwk.kty !== a.kty || (a.kty === 'EC' && jwk.crv !== 'P-256')) throw new Error('key type does not match alg');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return crypto.verify(a.hash, Buffer.from(t.input), { key, ...a.opts }, t.sig);
}
function thumbprint(jwk) {
  const m = jwk.kty === 'EC' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return crypto.createHash('sha256').update(JSON.stringify(m)).digest('base64url');
}

const cache = new Map(); // clientId -> { at, jwks }
const jtis = new Map();  // replay cache: jti -> expiry ms
const sessions = new Map(); // `${client}|${sid}|${sub}` -> { ended }

async function getJson(url, allowHttp) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error('https required');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) }); // no redirects (spec step 1)
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const text = await res.text();
  if (text.length > 100000) throw new Error('document too large');
  return JSON.parse(text);
}
async function clientKeys(clientId, allowHttp) {
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < 300000) return hit.keys;
  const meta = await getJson(clientId, allowHttp);
  if (meta.client_id !== clientId) throw new Error('client_id mismatch');
  if (meta.token_endpoint_auth_method !== 'private_key_jwt') throw new Error('client must use private_key_jwt');
  if (new URL(meta.jwks_uri).host !== new URL(clientId).host) throw new Error('jwks_uri must be on the client_id domain');
  const keys = (await getJson(meta.jwks_uri, allowHttp)).keys || [];
  cache.set(clientId, { at: Date.now(), keys });
  return keys;
}

const bad = (detail, error = 'invalid_session', status = 400) => ({ ok: false, status, error, detail });

// ctx: { cfg, audience, publicUrl, method, path, allowHttp, bearer }
async function verifySession(header, ctx) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const s = parse(header);
    if (s.header.typ !== 'poppy-session+jwt') return bad('wrong session typ');
    const c = s.payload;
    for (const k of ['iss', 'aud', 'sid', 'sub', 'htm', 'htu', 'iat', 'jti']) if (c[k] === undefined) return bad(`missing claim ${k}`);
    const client = ((ctx.cfg.poppy || {}).clients || []).find((x) => x.clientId === c.iss && x.enabled !== false);
    if (!client) return bad(`unregistered personal agent ${c.iss}`); // allowlist first: never fetch arbitrary URLs

    // 1. client metadata and keys
    const keys = await clientKeys(c.iss, ctx.allowHttp);

    // 2. delegation, then session signature
    const d = parse(s.header.poppy_dlg);
    if (d.header.typ !== 'poppy-delegation+jwt') return bad('wrong delegation typ');
    const signer = keys.find((k) => k.kid === d.header.kid || thumbprint(k) === d.header.kid);
    if (!signer) return bad('delegation signed by unknown key');
    if (!verifySig(d, signer)) return bad('delegation signature invalid');
    const dc = d.payload;
    if (dc.iss !== c.iss) return bad('delegation issuer mismatch');
    if (!dc.cnf || !dc.cnf.jwk) return bad('delegation has no cnf.jwk');
    if (!(dc.exp > now) || dc.exp - dc.iat > 86400 || dc.iat > now + 60) return bad('delegation expired or lifetime over 24h');
    if (['sub', 'aud', 'agent_id'].some((k) => dc[k] !== undefined)) return bad('delegation must not carry user or company identifiers');
    if (thumbprint(dc.cnf.jwk) !== s.header.kid) return bad('session kid does not match delegated key');
    if (!verifySig(s, dc.cnf.jwk)) return bad('session signature invalid');

    if (c.aud !== ctx.audience) return bad('wrong audience');
    if (c.htm !== ctx.method || c.htu !== ctx.publicUrl + ctx.path) return bad('request not bound to this method and URL');
    if (Math.abs(now - c.iat) > 60) return bad('iat outside acceptance window');
    if (c.ath !== undefined) return bad('access tokens are not supported by this prototype (no OAuth sign-in)');

    for (const [j, exp] of jtis) if (exp < Date.now()) jtis.delete(j); // replay protection
    if (jtis.has(c.jti)) return bad('jti reused');
    jtis.set(c.jti, Date.now() + 120000);

    // 3. session lookup
    const key = `${c.iss}|${c.sid}|${c.sub}`;
    let sess = sessions.get(key), isNew = false;
    if (sess && sess.ended) return bad('session ended', 'session_ended');
    if (!sess) { sess = { ended: false, started: Date.now() }; sessions.set(key, sess); isNew = true; }

    // 4. map to our world: registered agent + linked user
    const user = (ctx.cfg.poppy.users || {})[c.sub];
    if (!user) return bad(`user ${c.sub} is not linked to an account`, 'user_not_linked', 403);
    return { ok: true, agent: client.agent, sub: c.sub, user, sid: c.sid, key, isNew };
  } catch (e) {
    return bad(String(e.message || e));
  }
}
const endSession = (key) => { const s = sessions.get(key); if (s) s.ended = true; };
const reset = () => { cache.clear(); jtis.clear(); sessions.clear(); };

module.exports = { verifySession, endSession, thumbprint, reset };
