// Real React + isolated Chromium; module/SDK boundaries are explicit TEST DOUBLES.
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({
  root, configFile: false, server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'capture-cancellation-test-seams', enforce: 'pre',
    transform(code, id) {
      const path = id.replaceAll('\\', '/');
      if (path.endsWith('/src/ai/product-ai.ts')) {
        // Only replace the SDK/runner boundary; execute the real public release guard.
        const start = code.indexOf('const localRunner = createLocalInferenceRunner();');
        const end = code.indexOf('export function cancelLocalExtraction()');
        assert.ok(start >= 0 && end > start, 'Product AI runner test seam must match');
        return (code.slice(0, start) + 'const localRunner = window.__captureTest.runner;\n' + code.slice(end))
          .replace("import { ai } from '../lib/firebase';", 'const ai = {};');
      }
      if (!path.endsWith('/src/ui/ProductApp.tsx')) return;
      return code.replace('function Capture(', 'export function Capture(')
        .replaceAll("import('../ai/product-ai')", 'window.__captureTest.loadService()');
    },
    configureServer(server) {
      server.middlewares.use('/capture-cancellation.html', (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><body><script type="module" src="/tests/fixtures/capture-cancellation.tsx"></script></body></html>');
      });
    },
  }],
});
let browser;
let failed = 0; let passed = 0;
const tests = [];
const test = (name, run) => tests.push({ name, run });
const scope = page => page.locator('#capture-a');
const note = 'TEST DOUBLE original private note';
async function api(page, action, ...args) { return page.evaluate(({ action, args }) => window.__captureTest[action](...args), { action, args }); }
async function snapshot(page) { return api(page, 'snapshot'); }
async function start(page, kind, container = scope(page)) {
  await container.getByRole('button', { name: ({ extract: 'Extract on device', prepare: 'Prepare on-device AI', release: 'Release idle model' })[kind], exact: true }).click();
}
async function cancel(page, container = scope(page)) {
  await container.getByRole('button', { name: 'Cancel local request', exact: true }).click({ timeout: 1500 });
}
async function seed(page) {
  await scope(page).getByLabel('Field note').fill(note);
  await scope(page).locator('input[type=file]').setInputFiles({ name: 'TEST-DOUBLE-evidence.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE3sAAAAASUVORK5CYII=', 'base64') });
}
for (const kind of ['extract', 'prepare', 'release']) {
  test(`${kind}: cancel unresolved import unlocks retained input and manual entry`, async page => {
    await seed(page); await start(page, kind);
    assert.equal((await snapshot(page)).modules, 1);
    await expect(scope(page).getByLabel('Field note')).toBeDisabled();
    if (kind === 'release') await expect(scope(page).locator('.rt-status')).toHaveText('Releasing idle model…');
    await cancel(page);
    await expect(scope(page).getByLabel('Field note')).toBeEnabled({ timeout: 1500 });
    await expect(scope(page).getByLabel('Field note')).toHaveValue(note);
    await expect(scope(page).locator('input[type=file]')).toBeEnabled();
    assert.equal(await scope(page).locator('input[type=file]').evaluate(node => node.files[0].name), 'TEST-DOUBLE-evidence.png');
    await expect(scope(page).getByAltText('Selected local evidence preview')).toBeVisible();
    await scope(page).getByRole('button', { name: 'Use manual entry', exact: true }).click();
    await scope(page).getByRole('textbox', { name: /^Observation/ }).fill('TEST DOUBLE manual retained observation');
    await scope(page).getByRole('checkbox').check();
    await expect(scope(page).getByRole('button', { name: 'Commit capsule locally', exact: true })).toBeEnabled();
    assert.deepEqual(await snapshot(page), { modules: 1, calls: [], cancelled: [] });
  });
}

// A frame flush makes negative DOM assertions inspect committed React updates.
async function flush(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
for (const kind of ['extract', 'prepare', 'release']) {
  for (const outcome of ['resolve', 'reject']) {
    for (const replacementLoaded of [false, true]) {
      test(`${kind}: late import ${outcome} cannot affect ${replacementLoaded ? 'started' : 'pending'} replacement`, async page => {
        await seed(page); await start(page, kind); await cancel(page);
        await start(page, kind === 'extract' ? 'prepare' : 'extract');
        if (replacementLoaded) await api(page, 'resolveModule', 1);
        await flush(page);
        const status = await scope(page).locator('.rt-status').innerText();
        await api(page, outcome === 'resolve' ? 'resolveModule' : 'rejectModule', 0); await flush(page);
        await expect(scope(page).locator('.rt-status')).toHaveText(status);
        await expect(scope(page).getByLabel('Field note')).toBeDisabled();
        await expect(scope(page).locator('.rt-error')).toHaveCount(0);
        assert.equal((await snapshot(page)).calls.length, replacementLoaded ? 1 : 0);
        assert.deepEqual((await snapshot(page)).cancelled, []);
        assert.equal(await api(page, 'releaseCount'), 0);
        if (!replacementLoaded) await api(page, 'resolveModule', 1);
        await flush(page);
        assert.equal((await snapshot(page)).calls.length, 1);
        await cancel(page);
        assert.deepEqual((await snapshot(page)).cancelled, [0]);
        assert.equal((await snapshot(page)).calls[0].aborted, true);
        await expect(scope(page).getByLabel('Field note')).toBeEnabled();
        await expect(scope(page).getByLabel('Field note')).toHaveValue(note);
      });
    }
  }
  for (const outcome of kind === 'release' ? [] : ['resolve', 'reject']) {
    test(`${kind}: cancelled SDK callbacks and late ${outcome} cannot affect replacement`, async page => {
      await seed(page); await start(page, kind); await api(page, 'resolveModule', 0); await flush(page);
      assert.equal((await snapshot(page)).calls.length, 1);
      await cancel(page); assert.equal((await snapshot(page)).calls[0].aborted, true);
      await scope(page).getByRole('button', { name: 'Use manual entry', exact: true }).click();
      await scope(page).getByRole('textbox', { name: /^Observation/ }).fill('TEST DOUBLE manual text must survive');
      await start(page, kind === 'extract' ? 'prepare' : 'extract'); await api(page, 'resolveModule', 1); await flush(page);
      const status = await scope(page).locator('.rt-status').innerText();
      await api(page, 'emit', 0); await flush(page);
      await expect(scope(page).locator('.rt-status')).toHaveText(status);
      await expect(scope(page).getByLabel('Last local inference latency')).toHaveCount(0);
      await api(page, 'settle', 0, outcome); await flush(page);
      await expect(scope(page).locator('.rt-status')).toHaveText(status);
      await expect(scope(page).locator('.rt-error')).toHaveCount(0);
      await expect(scope(page).getByLabel('Field note')).toBeDisabled();
      await expect(scope(page).getByText('On-device draft', { exact: true })).toHaveCount(0);
      assert.deepEqual((await snapshot(page)).cancelled, [0]);
      assert.equal((await snapshot(page)).calls[1].aborted, false);
      await cancel(page);
      assert.deepEqual((await snapshot(page)).cancelled, [0, 1]);
      await scope(page).getByRole('button', { name: 'Use manual entry', exact: true }).click();
      await expect(scope(page).getByRole('textbox', { name: /^Observation/ })).toHaveValue('TEST DOUBLE manual text must survive');
      await expect(scope(page).getByLabel('Field note')).toHaveValue(note);
      assert.equal(await scope(page).locator('input[type=file]').evaluate(node => node.files[0].name), 'TEST-DOUBLE-evidence.png');
    });
  }
}

for (const kind of ['extract', 'prepare']) {
  test(`${kind}: active real runner cancellation aborts its owned synthetic SDK lifetime`, async page => {
    await seed(page); await start(page, kind); await api(page, 'resolveRunnerModule', 0); await flush(page);
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: true, cancelled: 0, aborted: [false] });
    await cancel(page); await flush(page);
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: false, cancelled: 1, aborted: [true] });
    await expect(scope(page).getByLabel('Field note')).toBeEnabled();
    await expect(scope(page).getByLabel('Field note')).toHaveValue(note);
    await expect(scope(page).locator('.rt-status')).toContainText('Local request cancelled.');
    await expect(scope(page).locator('.rt-error')).toHaveCount(0);
  });
  test(`${kind}: unmount of import-pending component leaves new component runner alone`, async page => {
    await seed(page); await start(page, kind);
    await api(page, 'mount', 'b'); const other = page.locator('#capture-b');
    await other.getByLabel('Field note').fill('TEST DOUBLE new component note');
    await start(page, kind, other); await api(page, 'resolveRunnerModule', 1); await flush(page);
    await api(page, 'unmount', 'a'); await api(page, 'resolveRunnerModule', 0); await flush(page);
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: true, cancelled: 0, aborted: [false] });
    await expect(other.getByLabel('Field note')).toBeDisabled();
    await api(page, 'unmount', 'b');
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: false, cancelled: 1, aborted: [true] });
  });
  test(`${kind}: unmount of rejected contender cannot cancel another component's runner`, async page => {
    await seed(page); await start(page, kind); await api(page, 'resolveRunnerModule', 0); await flush(page);
    await api(page, 'mount', 'b'); const other = page.locator('#capture-b');
    await other.getByLabel('Field note').fill('TEST DOUBLE competing component');
    await start(page, kind, other);
    await page.evaluate(() => {
      window.__captureTest.resolveRunnerModule(1);
      queueMicrotask(() => window.__captureTest.unmount('b'));
    });
    await flush(page);
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: true, cancelled: 0, aborted: [false] });
    await expect(scope(page).getByLabel('Field note')).toBeDisabled();
    await cancel(page);
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: false, cancelled: 1, aborted: [true] });
  });
}

for (const race of [false, true]) {
  test(`release: component B cannot abort A ${race ? 'starting after click before import resolves' : 'already active at click'}`, async page => {
    await seed(page);
    await api(page, 'mount', 'b'); const other = page.locator('#capture-b');
    if (race) {
      await start(page, 'release', other);
      await start(page, 'extract'); await api(page, 'resolveRunnerModule', 1);
    } else {
      await start(page, 'extract'); await api(page, 'resolveRunnerModule', 0);
      await start(page, 'release', other);
    }
    await flush(page);
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: true, cancelled: 0, aborted: [false] });
    const status = await scope(page).locator('.rt-status').innerText();
    await api(page, 'resolveRunnerModule', race ? 0 : 1); await flush(page);
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: true, cancelled: 0, aborted: [false] });
    await expect(scope(page).locator('.rt-status')).toHaveText(status);
    await expect(scope(page).getByLabel('Field note')).toBeDisabled();
    await expect(other.getByLabel('Field note')).toBeEnabled();
    await expect(other.locator('.rt-error')).toContainText('already running');
    await expect(other.getByText('Idle model released. Your draft and local records are unchanged.', { exact: true })).toHaveCount(0);
    await api(page, 'unmount', 'b'); await flush(page);
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: true, cancelled: 0, aborted: [false] });
    await cancel(page); await flush(page);
    assert.deepEqual(await api(page, 'runnerSnapshot'), { running: false, cancelled: 1, aborted: [true] });
  });
}

try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/capture-cancellation.html`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const { name, run } of tests.filter(test => !process.argv[2] || test.name.includes(process.argv[2]))) {
    const context = await browser.newContext(); const page = await context.newPage(); const errors = [];
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(url); await scope(page).getByLabel('Field note').waitFor();
      await run(page); assert.deepEqual(errors, []); passed++; console.log(`PASS ${name}`);
    } catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}\nDOM: ${await page.locator('body').innerText()}\nSTATE: ${JSON.stringify(await snapshot(page))}`); }
    finally { await context.close(); }
  }
} finally { await browser?.close(); await server.close(); }
console.log(`Capture cancellation regression: ${passed} passed, ${failed} failed. TEST DOUBLES only; no real AI/hardware calls.`);
if (!passed && !failed) throw new Error('No matching regression tests selected');
if (failed) process.exitCode = 1;
