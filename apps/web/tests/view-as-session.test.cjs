'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const sourceRoot = path.resolve(__dirname, '../src');
function load(relative, context, resolve = require) {
  const filename = path.join(sourceRoot, relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: resolve, ...context }, { filename });
  return module.exports;
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial)), writes = [];
  return {
    writes,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); writes.push(['set', key, String(value)]); },
    removeItem: key => { values.delete(key); writes.push(['remove', key]); },
  };
}

function browser(initial = {}) {
  const localStorage = storage(initial), sessionStorage = storage(), listeners = new Map();
  const state = { reloads: 0 };
  const window = {
    localStorage, sessionStorage,
    location: { href: '/settings/users', reload: () => { state.reloads++; } },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  return { window, localStorage, sessionStorage, state, listeners };
}

const capabilities = load('lib/view-as.ts', {});
test('only a freshly verified identity enables View As; SUPER_ADMIN works without a seeded permission key', () => {
  assert.equal(capabilities.viewAsCapabilities(null, ['user.manage', 'user.impersonate']).canImpersonate, false);
  assert.equal(capabilities.viewAsCapabilities({ role: 'SUPER_ADMIN' }, []).canImpersonate, false);
  const owner = capabilities.viewAsCapabilities({ userId: 'owner', role: 'SUPER_ADMIN' }, []);
  assert.equal(owner.canManage, true);
  assert.equal(owner.canImpersonate, true);
  assert.equal(owner.isSuperAdmin, true);
  assert.equal(capabilities.viewAsCapabilities({ id: 'staff', role: 'USER' }, []).canImpersonate, false);
  assert.equal(capabilities.viewAsCapabilities({ id: 'staff', role: 'USER' }, ['user.impersonate']).canImpersonate, true);
  assert.equal(capabilities.viewAsCapabilities({ userId: 'owner', role: 'SUPER_ADMIN', impersonatedBy: 'other' }, []).canImpersonate, false);
});

test('self and inactive users cannot be previewed; protected targets require a Super Admin actor', () => {
  const target = { id: 'target', status: 'ACTIVE', role: 'USER' };
  assert.equal(capabilities.viewAsDisabledReason(target, 'actor'), null);
  assert.match(capabilities.viewAsDisabledReason(target, null), /verified/);
  assert.match(capabilities.viewAsDisabledReason(target, 'target', true), /own account/);
  assert.match(capabilities.viewAsDisabledReason({ ...target, status: 'INACTIVE' }, 'actor', true), /active/);
  assert.match(capabilities.viewAsDisabledReason({ ...target, role: 'SUPER_ADMIN' }, 'actor'), /Super Admin/);
  assert.equal(capabilities.viewAsDisabledReason({ ...target, role: 'SUPER_ADMIN' }, 'actor', true), null);
});

test('session installation removes previous memberships, tenant and team state and publishes token last', () => {
  const b = browser({
    access_token: 'admin', refresh_token: 'admin-refresh', user: '{"id":"admin"}',
    tenant: '{"id":"previous"}', current_tenant_id: 'previous', memberships: '[{"tenantId":"secret"}]',
    current_team_id: 'old-team', current_team_ids: '["old-team"]',
  });
  const session = load('lib/session.ts', b);
  session.applySession({ accessToken: 'preview', refreshToken: 'preview-refresh', user: { id: 'target' } });
  assert.equal(b.localStorage.getItem('tenant'), null);
  assert.equal(b.localStorage.getItem('current_tenant_id'), null);
  assert.equal(b.localStorage.getItem('memberships'), '[]');
  assert.equal(b.localStorage.getItem('current_team_id'), null);
  assert.equal(b.localStorage.getItem('current_team_ids'), null);
  assert.deepEqual(b.localStorage.writes.at(-1), ['set', 'access_token', 'preview']);
  assert.equal(session.getPageSessionToken(), 'preview');
  assert.equal(session.isCurrentSessionAuthorization('Bearer admin'), false);
  assert.equal(session.isCurrentSessionAuthorization('Bearer preview'), true);
});

test('preview marker is installed before its token becomes visible to another tab and is cleared on restoration', () => {
  const b = browser({ access_token: 'admin' }), session = load('lib/session.ts', b);
  session.applySession({
    accessToken: 'preview', impersonatedBy: 'admin', impersonationReadOnly: true,
    user: { id: 'target', firstName: 'Target', email: 'target@example.test' },
    tenant: { id: 'active-tenant' }, memberships: [{ tenantId: 'active-tenant' }],
  });
  const markerIndex = b.localStorage.writes.findIndex(write => write[1] === 'impersonating_user');
  const tokenIndex = b.localStorage.writes.findIndex(write => write[1] === 'access_token');
  assert.ok(markerIndex >= 0 && markerIndex < tokenIndex);
  assert.equal(JSON.parse(b.localStorage.getItem('impersonating_user')).email, 'target@example.test');
  session.applySession({ accessToken: 'restored-admin', user: { id: 'admin' }, tenant: { id: 'active-tenant' } });
  assert.equal(b.localStorage.getItem('impersonating_user'), null);
});

test('other tabs clear their query cache and reload on identity replacement, including logout', () => {
  const b = browser({ access_token: 'admin' }), session = load('lib/session.ts', b);
  let clears = 0;
  const unwatch = session.watchSessionChanges(() => { clears++; });
  b.localStorage.setItem('user', '{"id":"target"}');
  b.listeners.get('storage')({ key: 'user', storageArea: b.localStorage });
  assert.equal(clears, 0);
  b.localStorage.setItem('access_token', 'preview');
  b.listeners.get('storage')({ key: 'access_token', storageArea: b.localStorage });
  assert.equal(clears, 1);
  assert.equal(b.state.reloads, 1);
  assert.throws(() => session.getPageSessionToken(), /session changed/);
  b.localStorage.removeItem('access_token');
  b.listeners.get('storage')({ key: null, storageArea: b.localStorage });
  assert.equal(clears, 2);
  unwatch();
  assert.equal(b.listeners.has('storage'), false);
});

function clientFixture(initial) {
  const b = browser(initial), session = load('lib/session.ts', b), handlers = {};
  const client = {
    interceptors: {
      request: { use: fn => { handlers.request = fn; } },
      response: { use: (ok, fail) => { handlers.ok = ok; handlers.fail = fail; } },
    },
  };
  load('lib/api-client.ts', { ...b, process: { env: {} } }, name => {
    if (name === 'axios') return { create: () => client };
    if (name === '@/lib/session') return session;
    throw new Error(`Unexpected import ${name}`);
  });
  return { ...b, session, handlers };
}

test('old in-flight responses cannot replace the new preview data or expire its token', async () => {
  const c = clientFixture({ access_token: 'admin' });
  const old = c.handlers.request({ headers: {} });
  c.session.applySession({ accessToken: 'preview', user: { id: 'target' } });
  await assert.rejects(c.handlers.ok({ config: old, data: 'old admin data' }), /session changed/);
  await assert.rejects(c.handlers.fail({ response: { status: 401 }, config: old }));
  assert.equal(c.localStorage.getItem('access_token'), 'preview');
  assert.equal(c.window.location.href, '/settings/users');
});

test('expired current preview clears all identity data and provides an own-account login message', async () => {
  const c = clientFixture({
    access_token: 'preview', refresh_token: 'refresh', user: '{"id":"target"}', tenant: '{"id":"tenant"}',
    memberships: '[{}]', current_tenant_id: 'tenant', current_team_id: 'team', current_team_ids: '["team"]',
    impersonating_user: '{"name":"Target","email":"target@example.test"}',
  });
  const config = c.handlers.request({ headers: {} });
  await assert.rejects(c.handlers.fail({ response: { status: 401 }, config }));
  for (const key of ['access_token', 'refresh_token', 'user', 'tenant', 'memberships', 'current_tenant_id', 'current_team_id', 'current_team_ids', 'impersonating_user']) {
    assert.equal(c.localStorage.getItem(key), null, key);
  }
  assert.equal(c.window.location.href, '/login');
  assert.match(c.sessionStorage.getItem('auth_session_notice'), /own account/);
});

test('login failure without a session bearer does not discard a separately installed identity', async () => {
  const c = clientFixture({ access_token: 'preview' });
  await assert.rejects(c.handlers.fail({ response: { status: 401 }, config: { headers: {} } }));
  assert.equal(c.localStorage.getItem('access_token'), 'preview');
});

function impersonationFixture(initial, post) {
  const b = browser(initial), session = load('lib/session.ts', b);
  const api = load('lib/impersonation.ts', b, name => {
    if (name === '@/lib/session') return session;
    if (name === '@/lib/api-client') return { post, get: async () => ({ data: { user: {} } }) };
    throw new Error(`Unexpected import ${name}`);
  });
  return { ...b, api };
}

test('start installs target identity and hard-navigates; exit restores admin memberships and removes preview', async () => {
  const requests = [];
  const c = impersonationFixture({ access_token: 'admin' }, async url => {
    requests.push(url);
    return { data: url.endsWith('/stop')
      ? { accessToken: 'admin-return', user: { id: 'admin' }, tenant: { id: 't1' }, memberships: [{ tenantId: 't1' }, { tenantId: 't2' }] }
      : { accessToken: 'target', impersonatedBy: 'admin', impersonationReadOnly: true, user: { id: 'target', firstName: 'Test', email: 'target@example.test' }, tenant: { id: 't1' }, memberships: [{ tenantId: 't1' }] } };
  });
  await c.api.startImpersonation('target');
  assert.equal(c.window.location.href, '/dashboard');
  assert.equal(c.api.getImpersonation().name, 'Test');
  assert.equal(c.localStorage.getItem('access_token'), 'target');
  await c.api.stopImpersonation();
  assert.equal(c.window.location.href, '/settings/users');
  assert.equal(c.localStorage.getItem('access_token'), 'admin-return');
  assert.equal(JSON.parse(c.localStorage.getItem('memberships')).length, 2);
  assert.equal(c.api.getImpersonation(), null);
  assert.deepEqual(requests, ['/auth/impersonate/target', '/auth/impersonate/stop']);
});

test('a legacy writable impersonation response is rejected without changing the admin session', async () => {
  const c = impersonationFixture({ access_token: 'admin' }, async () => ({ data: { accessToken: 'target', user: { id: 'target' }, impersonatedBy: 'admin' } }));
  await assert.rejects(c.api.startImpersonation('target'), /Read-only preview is not available/);
  assert.equal(c.localStorage.getItem('access_token'), 'admin');
  assert.equal(c.api.getImpersonation(), null);
});

test('failed Exit keeps the preview label; only a server-confirmed stale session clears it', async () => {
  const initial = { access_token: 'target', impersonating_user: '{"name":"Target","email":"target@example.test"}' };
  const failed = impersonationFixture(initial, async () => { throw { response: { status: 503 } }; });
  await assert.rejects(failed.api.stopImpersonation());
  assert.equal(failed.api.getImpersonation().name, 'Target');
  const stale = impersonationFixture(initial, async () => { throw { response: { status: 400 } }; });
  await stale.api.stopImpersonation();
  assert.equal(stale.api.getImpersonation(), null);
  assert.equal(stale.state.reloads, 1);
});

test('preview banner visibly identifies read-only mode and a persistent return action', () => {
  let stateIndex = 0;
  const states = [{ name: 'Target User', email: 'target@example.test' }, false, null];
  const { ImpersonationBanner } = load('app/(dashboard)/_components/impersonation-banner.tsx', {}, name => {
    if (name === 'react') return { useState: () => [states[stateIndex++], () => {}], useEffect: () => {} };
    if (name === 'react/jsx-runtime') return require(name);
    if (name === 'lucide-react') return { Eye: () => React.createElement('svg') };
    if (name === '@/lib/impersonation') return {};
    throw new Error(`Unexpected import ${name}`);
  });
  const html = renderToStaticMarkup(React.createElement(ImpersonationBanner));
  assert.match(html, /Read-only preview:/);
  assert.match(html, /Target User/);
  assert.match(html, /target@example.test/);
  assert.match(html, /Record changes are blocked/);
  assert.match(html, /Exit preview/);
  assert.match(html, /sticky top-0/);
});

test('preview sockets never connect or receive an auth token; ordinary socket sessions retain connection settings', () => {
  for (const preview of [true, false]) {
    const b = browser({ access_token: preview ? 'preview' : 'admin', ...(preview ? { impersonating_user: '{}' } : {}) });
    const session = load('lib/session.ts', b), calls = [];
    const socket = { connected: false, disconnect() {}, emit() {}, on() {}, off() {} };
    const client = load('lib/socket-client.ts', { ...b, process: { env: { NEXT_PUBLIC_API_URL: 'https://api.example.test/api/v1' } }, URL }, name => {
      if (name === 'socket.io-client') return { io: (...args) => { calls.push(args); return socket; } };
      if (name === '@/lib/session') return session;
      throw new Error(`Unexpected import ${name}`);
    }).workflowSocket;
    assert.equal(client.connect(), socket);
    if (preview) {
      assert.equal(calls[0][0].autoConnect, false);
      assert.equal(calls[0][0].reconnection, false);
      assert.equal(calls[0][0].auth, undefined);
    } else {
      assert.equal(calls[0][0], 'https://api.example.test/workflows');
      assert.equal(calls[0][1].auth.token, 'admin');
    }
  }
});
