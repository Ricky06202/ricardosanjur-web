import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.ts';

const env = { ADMIN_EMAILS: 'admin@example.com', ADMIN_TOKEN: 'test-token', ADMIN_SESSION_SECRET: 'test-session-secret', ASSETS: { fetch: () => new Response('asset') } };
const origin = 'https://www.ricardosanjur.com';

test('login binds the callback to the browser attempt and retains admin authorization', async () => {
  const start = await worker.fetch(new Request(origin + '/admin/iniciar'), env, {});
  assert.equal(start.status, 303);
  const url = new URL(start.headers.get('location'));
  assert.equal(url.pathname, '/api/auth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'ricardosanjur-web');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const state = url.searchParams.get('state');
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const payload = JSON.parse(init.body);
    assert.equal(payload.client_id, 'ricardosanjur-web');
    assert.equal(payload.state, state);
    assert.equal(payload.code_verifier.length, 43);
    assert.equal(new Headers(init.headers).has('x-rsid-app-secret'), false);
    return Response.json({ email: 'admin@example.com', cuenta_id: 'test-account' });
  };
  try {
    const invalid = await worker.fetch(new Request(origin + '/admin/entrar?code=' + 'a'.repeat(43) + '&state=' + 'b'.repeat(43), { headers: { cookie } }), env, {});
    assert.equal(invalid.headers.get('location'), '/admin?error=sesion_expirada');
    assert.equal(calls, 0);
    const valid = await worker.fetch(new Request(origin + '/admin/entrar?code=' + 'a'.repeat(43) + '&state=' + state, { headers: { cookie } }), env, {});
    assert.equal(valid.headers.get('location'), '/admin');
    assert.match(valid.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(calls, 1);
    const denied = await worker.fetch(new Request(origin + '/admin/entrar?code=' + 'a'.repeat(43) + '&state=' + state, { headers: { cookie } }), { ...env, ADMIN_EMAILS: 'other@example.com' }, {});
    assert.equal(denied.status, 401);
  } finally { globalThis.fetch = original; }
});
