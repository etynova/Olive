const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { after, before, describe, it } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const testCredential = 'olive-connector-fixture-only';
let sampleProcess;
let oliveProcess;
let systemOrigin;
let oliveOrigin;

/*
 * Find a loopback port without reserving it for the lifetime of a process.
 * The tiny release/bind race is preferable to hard-coding example ports:
 * developers can run these integration checks alongside their own services.
 */
async function allocatePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/*
 * Poll only the child process's local HTTP health endpoint. A fixed startup
 * sleep would make tests slow on a fast machine and flaky on a slower one;
 * checking that the child stays alive ensures failed startup is reported.
 */
async function waitForHealth(child, url, headers = {}) {
  const deadline = Date.now() + 6000;
  let lastError = 'The child process has not opened its health endpoint.';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test service exited with code ${child.exitCode}: ${lastError}`);
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
      lastError = `Health endpoint returned HTTP ${response.status}.`;
    } catch (error) {
      lastError = error.message;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for a test service: ${lastError}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

before(async () => {
  const systemPort = await allocatePort();
  const olivePort = await allocatePort();
  systemOrigin = `http://127.0.0.1:${systemPort}`;
  oliveOrigin = `http://127.0.0.1:${olivePort}`;
  const node = process.execPath;

  /*
   * Each child receives its own environment object. Test credentials therefore
   * reach the connector process but never modify the test runner's process,
   * persist to disk, appear in application output, or enter version control.
   */
  sampleProcess = spawn(node, ['examples/school-system.js'], {
    cwd: projectRoot,
    env: { ...process.env, SCHOOL_SYSTEM_PORT: String(systemPort), SCHOOL_SYSTEM_TOKEN: testCredential },
    stdio: 'ignore',
  });
  await waitForHealth(sampleProcess, `${systemOrigin}/health`, { authorization: `Bearer ${testCredential}` });

  oliveProcess = spawn(node, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(olivePort),
      OLIVE_SYSTEM_URL: systemOrigin,
      OLIVE_SYSTEM_NAME: 'Olive integration fixture',
      OLIVE_SYSTEM_TOKEN: testCredential,
    },
    stdio: 'ignore',
  });
  await waitForHealth(oliveProcess, `${oliveOrigin}/health`);
});

after(async () => {
  await stopChild(oliveProcess);
  await stopChild(sampleProcess);
});

describe('configured school-system integration', () => {
  it('reports capabilities without exposing its API token or target URL', async () => {
    const response = await fetch(`${oliveOrigin}/api/integration/config`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.configured, true);
    assert.equal(payload.systemName, 'Olive integration fixture');
    assert.deepEqual(payload.capabilities, { search: true, handoff: true });
    assert.equal(JSON.stringify(payload).includes(testCredential), false);
    assert.equal(JSON.stringify(payload).includes(systemOrigin), false);
  });

  it('requires an explicit local same-origin connector health test', async () => {
    const notBrowserInitiated = await fetch(`${oliveOrigin}/api/integration/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(notBrowserInitiated.status, 403);

    const response = await fetch(`${oliveOrigin}/api/integration/test`, {
      method: 'POST',
      headers: { origin: oliveOrigin, 'content-type': 'application/json' },
      body: '{}',
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.match(payload.message, /responded successfully/);
  });

  it('rejects a token over remote HTTP rather than silently sending it in clear text', async () => {
    const port = await allocatePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(port),
        OLIVE_SYSTEM_URL: 'http://school-api.example.org',
        OLIVE_SYSTEM_TOKEN: testCredential,
      },
      stdio: 'ignore',
    });
    try {
      const origin = `http://127.0.0.1:${port}`;
      await waitForHealth(child, `${origin}/health`);
      const response = await fetch(`${origin}/api/integration/config`);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.configured, false);
      assert.match(payload.message, /requires HTTPS/);
      assert.equal(JSON.stringify(payload).includes(testCredential), false);
    } finally {
      await stopChild(child);
    }
  });

  it('searches the connected school directory, encodes queries, and uses its server-held token', async () => {
    const query = 'Where is the library?';
    const response = await fetch(`${oliveOrigin}/api/integration/search?q=${encodeURIComponent(query)}`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.systemName, 'Olive integration fixture');
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].title, 'Library · Room 1.08');
    assert.match(payload.results[0].detail, /green corridor/);

    const missingQuery = await fetch(`${oliveOrigin}/api/integration/search?q=%20`);
    const invalidLength = await fetch(`${oliveOrigin}/api/integration/search?q=${'x'.repeat(241)}`);
    assert.equal(missingQuery.status, 400);
    assert.equal(invalidLength.status, 400);
  });

  it('never returns demo search results when the connected system has no match', async () => {
    const response = await fetch(`${oliveOrigin}/api/integration/search?q=${encodeURIComponent('an unknown confidential request')}`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.results, []);
    assert.notEqual(payload.results[0]?.title, 'Sample directory has no matching entry.');
  });

  it('requires an explicit same-origin JSON confirmation before handoff', async () => {
    const body = JSON.stringify({
      confirmed: true,
      query: 'Where is the library?',
      resultTitle: 'Library · Room 1.08',
    });
    const deniedOrigin = await fetch(`${oliveOrigin}/api/integration/handoff`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body,
    });
    const deniedType = await fetch(`${oliveOrigin}/api/integration/handoff`, {
      method: 'POST',
      headers: { origin: oliveOrigin, 'content-type': 'text/plain' },
      body,
    });
    const missingConsent = await fetch(`${oliveOrigin}/api/integration/handoff`, {
      method: 'POST',
      headers: { origin: oliveOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Where is the library?', resultTitle: 'Library · Room 1.08' }),
    });
    assert.equal(deniedOrigin.status, 403);
    assert.equal(deniedType.status, 415);
    assert.equal(missingConsent.status, 400);

    const accepted = await fetch(`${oliveOrigin}/api/integration/handoff`, {
      method: 'POST',
      headers: { origin: oliveOrigin, 'content-type': 'application/json' },
      body,
    });
    const payload = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.match(payload.message, /handoff accepted/);
    assert.equal(JSON.stringify(payload).includes(testCredential), false);

    const fixture = await fetch(`${systemOrigin}/admin/demo-handoffs`, {
      headers: { authorization: `Bearer ${testCredential}` },
    });
    const received = await fixture.json();
    assert.equal(received.total, 1);
    assert.equal(received.items[0].resultTitle, 'Library · Room 1.08');
    assert.equal(JSON.stringify(received).includes('Where is the library?'), false);
  });
});
