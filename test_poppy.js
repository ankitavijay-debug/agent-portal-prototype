// Poppy tests. Start the server first:
//   PORT=4398 POPPY_ALLOW_HTTP=1 node server.js     then:   node test_poppy.js http://localhost:4398
const crypto = require('crypto');
const http = require('http');
const base = process.argv[2] || 'http://localhost:4398';
const ADMIN = { Authorization: 'Bearer tok-admin', 'Content-Type': 'application/json' };
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${ok ? '' : x}`); };
const sign = (header, payload, key) => { const i = b64(header) + '.' + b64(payload); return i + '.' + crypto.sign('sha256', Buffer.from(i), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url'); };
const gen = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const thumb = (jwk) => crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');

(async () => {
  // A fake personal agent: publishes client metadata and keys on its own tiny server
  const main = gen(), dlg = gen(), other = gen();
  const mainJwk = main.publicKey.export({ format: 'jwk' }); mainJwk.kid = thumb(mainJwk);
  let clientUrl;
  const srv = http.createServer((q, s) => {
    s.setHeader('Content-Type', 'application/json');
    if (q.url === '/agent.json') s.end(JSON.stringify({ client_id: clientUrl, client_name: 'Test Claude', logo_uri: 'x', jwks_uri: clientUrl.replace('agent.json', 'jwks.json'), redirect_uris: [], token_endpoint_auth_method: 'private_key_jwt' }));
    else s.end(JSON.stringify({ keys: [mainJwk] }));
  }).listen(0);
  await new Promise((r) => srv.on('listening', r));
  clientUrl = `http://localhost:${srv.address().port}/agent.json`;

  const now = () => Math.floor(Date.now() / 1000);
  const mk = (o = {}) => {
    const dk = o.dlgKey || dlg, djwk = dk.publicKey.export({ format: 'jwk' });
    const d = sign({ alg: 'ES256', typ: 'poppy-delegation+jwt', kid: mainJwk.kid }, { iss: clientUrl, cnf: { jwk: djwk }, iat: now() - 5, exp: now() + 3600, jti: crypto.randomUUID(), ...(o.dlgClaims || {}) }, o.dlgSigner || main.privateKey);
    return (method, path, extra = {}) => sign({ typ: 'poppy-session+jwt', alg: 'ES256', kid: thumb(djwk), poppy_dlg: d },
      { iss: clientUrl, aud: base, sid: 'sess-1', sub: 'usr_7f3a91c2', htm: method, htu: base + path, iat: now(), jti: crypto.randomUUID(), ...extra }, o.sessSigner || dk.privateKey);
  };
  const call = async (method, path, hdr, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...hdr }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  const sessionHdr = (j) => ({ 'Poppy-Session': j });
  await call('POST', '/api/admin/reset');
  await call('POST', '/api/admin/config-reset', ADMIN);

  // --- discovery documents (items 2, 3) ---
  const doc = (await call('GET', '/.well-known/poppy.json')).body;
  check('poppy.json has version, organization and tasks endpoint', doc.protocol_version === '1.0' && doc.organization && doc.tasks.endpoint.endsWith('/poppy/tasks'));
  check('scope_hints derived from manifest: pay is irreversible', doc.auth.scope_hints.pay_diagnostic_fee.changes === 'irreversible');
  check('scope_hints: read is none, address change is personal data', doc.auth.scope_hints.check_warranty.changes === 'none' && doc.auth.scope_hints.change_address.personal_data === true);
  const tasks = (await call('GET', '/poppy/tasks')).body;
  check('tasks endpoint lists excluded tasks with alternatives', tasks.excluded_tasks.length >= 1 && tasks.excluded_tasks[0].task && tasks.excluded_tasks[0].alternative && tasks.feedback.endpoint);

  // --- admin: excluded tasks editor and registration (item 1, 4) ---
  const cfg0 = (await call('GET', '/api/admin/config', ADMIN)).body.config;
  const next = JSON.parse(JSON.stringify(cfg0));
  next.excluded.push({ task: 'Issue a refund', alternative: 'Ask a human agent' });
  next.poppy.clients = [{ clientId: clientUrl, agent: 'claude', enabled: true }];
  next.poppy.users = { usr_7f3a91c2: 'priya' };
  check('Admin saves excluded task and registered agent', (await call('POST', '/api/admin/config', ADMIN, { config: next, why: 'poppy test' })).status === 200);
  check('Published tasks update immediately', (await call('GET', '/poppy/tasks')).body.excluded_tasks.some((e) => e.task === 'Issue a refund'));
  const dup = JSON.parse(JSON.stringify(next)); dup.excluded.push({ task: 'check warranty' });
  check('Cannot exclude a task that is still an enabled action (422)', (await call('POST', '/api/admin/config', ADMIN, { config: dup })).status === 422);
  const badClient = JSON.parse(JSON.stringify(next)); badClient.poppy.clients.push({ clientId: 'ftp://nope', agent: 'claude' });
  check('Invalid client_id rejected (422)', (await call('POST', '/api/admin/config', ADMIN, { config: badClient })).status === 422);
  const pii = JSON.parse(JSON.stringify(next)); pii.poppy.users = { 'priya@example.com': 'priya' };
  check('User ID that looks like personal data rejected (422)', (await call('POST', '/api/admin/config', ADMIN, { config: pii })).status === 422);

  // --- Poppy session verification (item 4) ---
  const good = mk();
  const path = '/api/portal/goals';
  const created = await call('POST', path, sessionHdr(good('POST', path)), { objective: 'Fix my broken fridge under warranty' });
  check('Valid Poppy session creates a goal as Claude', created.status === 201, JSON.stringify(created.body));
  const g = created.body.goal && created.body.goal.id;
  const state = (await call('GET', '/api/state')).body;
  check('Ledger attributes goal to claude, audit shows verified session', state.goals[0] && state.goals[0].createdVia === 'claude' && state.audit.some((a) => a.type === 'poppy'));

  const reuse = good('GET', path);
  check('Valid GET session works', (await call('GET', path, sessionHdr(reuse))).status === 200);
  check('Replayed jti refused (400 invalid_session)', (await call('GET', path, sessionHdr(reuse))).body.error === 'invalid_session');
  check('Wrong method binding refused', (await call('GET', path, sessionHdr(good('POST', path)))).body.error === 'invalid_session');
  check('Wrong URL binding refused', (await call('GET', path, sessionHdr(good('GET', '/api/portal/other')))).body.error === 'invalid_session');
  check('Wrong audience refused', (await call('GET', path, sessionHdr(good('GET', path, { aud: 'https://evil.example' })))).body.error === 'invalid_session');
  check('Stale iat refused', (await call('GET', path, sessionHdr(good('GET', path, { iat: now() - 600 })))).body.error === 'invalid_session');
  check('Access token claim refused (no OAuth in prototype)', (await call('GET', path, sessionHdr(good('GET', path, { ath: 'abc' })))).body.error === 'invalid_session');
  check('Expired delegation refused', (await call('GET', path, sessionHdr(mk({ dlgClaims: { exp: now() - 10 } })('GET', path)))).body.error === 'invalid_session');
  check('Delegation over 24h refused', (await call('GET', path, sessionHdr(mk({ dlgClaims: { exp: now() + 200000 } })('GET', path)))).body.error === 'invalid_session');
  check('Delegation carrying a user ID refused', (await call('GET', path, sessionHdr(mk({ dlgClaims: { sub: 'usr_x' } })('GET', path)))).body.error === 'invalid_session');
  check('Delegation signed by an unknown key refused', (await call('GET', path, sessionHdr(mk({ dlgSigner: other.privateKey })('GET', path)))).body.error === 'invalid_session');
  check('Session signed with a key the delegation does not vouch for refused', (await call('GET', path, sessionHdr(mk({ sessSigner: other.privateKey })('GET', path)))).body.error === 'invalid_session');
  check('Unlinked user refused (403 user_not_linked)', (await call('GET', path, sessionHdr(good('GET', path, { sub: 'usr_unlinked1' })))).body.error === 'user_not_linked');
  const unreg = JSON.parse(JSON.stringify(next)); unreg.poppy.clients[0].enabled = false;
  await call('POST', '/api/admin/config', ADMIN, { config: unreg, why: 'disable agent' });
  check('Disabled or unregistered personal agent refused', (await call('GET', path, sessionHdr(good('GET', path)))).body.error === 'invalid_session');
  await call('POST', '/api/admin/config', ADMIN, { config: next, why: 'enable agent' });

  // scope still enforced behind Poppy: claude cannot request a tier 4 action
  const act = await call('POST', '/api/portal/actions', sessionHdr(good('POST', '/api/portal/actions')), { goalId: g, action: 'warranty_exception', params: {} });
  check('Portal scopes still apply to a Poppy session (403)', act.status === 403);

  // excluded/disabled task is reported as such
  const off = JSON.parse(JSON.stringify(next)); off.actions.change_address.enabled = false;
  await call('POST', '/api/admin/config', ADMIN, { config: off, why: 'disable change_address' });
  const r2 = await call('POST', '/api/portal/actions', sessionHdr(good('POST', '/api/portal/actions')), { goalId: g, action: 'change_address', params: { address: 'x' } });
  check('Disabled action returns task_excluded with pointer to tasks endpoint', r2.status === 403 && r2.body.code === 'task_excluded' && !!r2.body.see);
  const doc2 = (await call('GET', '/.well-known/poppy.json')).body;
  check('Disabled action disappears from published scopes', !doc2.auth.scopes.change_address);

  // session end
  const e = good('POST', '/poppy/session/end');
  check('Session can be ended', (await call('POST', '/poppy/session/end', sessionHdr(e))).status === 200);
  check('Ended session refused (400 session_ended)', (await call('GET', path, sessionHdr(good('GET', path)))).body.error === 'session_ended');

  await call('POST', '/api/admin/config-reset', ADMIN);
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
