// Real Sharing component in isolated Chromium; SDK calls are explicit TEST DOUBLES, never service evidence.
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Sharing } from '/src/ui/ProductApp.tsx';
window.React = React;
const project = { id: 'project-receipt-ui', title: 'TEST DOUBLE receipt inspection', description: '', createdAt: '2026-11-19T00:00:00.000Z' };
const capsule = { id: 'capsule-receipt-ui', projectId: project.id, parentId: null, createdAt: project.createdAt, confirmedAt: project.createdAt, originalNote: 'Synthetic UI fixture only', source: 'manual', fields: { observation: ['Synthetic'], attempted: [], changed: [], result: [], unresolved: [], next_check: [] } };
const payload = { schemaVersion: 1, project: { id: project.id, title: project.title }, capsules: [capsule] };
const jobs = ['approval-a', 'approval-b'].map(id => ({ id, projectId: project.id, approvedAt: project.createdAt, status: 'pending', attempts: 1, ownerId: 'synthetic-owner', payload }));
window.__receiptUi = {
 calls: [], uploads: 0, reloads: 0, settle: null,
 loadService: async () => ({
  checkApprovedJobReceipt: (projectId, jobId) => {
   window.__receiptUi.calls.push([projectId, jobId]);
   return new Promise((resolve, reject) => { window.__receiptUi.settle = { resolve, reject }; });
  },
  syncApprovedJobs: () => { window.__receiptUi.uploads++; throw new Error('TEST DOUBLE: upload is forbidden in a receipt check'); }
 })
};
createRoot(document.getElementById('root')).render(React.createElement(Sharing, { project, capsules: [capsule], jobs, reload: async () => { window.__receiptUi.reloads++; } }));
`;
const server = await createServer({
 root, configFile: false, cacheDir: 'node_modules/.cache/receipt-ui-vite', server: { host: '127.0.0.1', port: 0 },
 plugins: [{
  name: 'receipt-ui-test-double-boundary', enforce: 'pre',
  resolveId(id) { if (id === '/__receipt-ui-entry.js') return '\0receipt-ui-entry'; },
  load(id) { if (id === '\0receipt-ui-entry') return fixture; },
  transform(code, id) {
   if (!id.replaceAll('\\', '/').endsWith('/src/ui/ProductApp.tsx')) return;
   return code.replace('function Sharing(', 'export function Sharing(')
    .replaceAll("import('../sync/firebase-sync')", 'window.__receiptUi.loadService()');
  },
  configureServer(vite) {
   vite.middlewares.use('/receipt-ui.html', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/__receipt-ui-entry.js"></script></body></html>');
   });
  },
 }],
});
let browser;
const results = [];
const externalRequests = [];
const pageErrors = [];
const tests = [];
const test = (name, run) => tests.push({ name, run });
const row = page => page.locator('.rt-job').filter({ hasText: 'approval-b' });
const control = page => row(page).getByRole('button', { name: 'Check server receipt (read only)', exact: true });
async function assertReadOnly(page) {
 const state = await page.evaluate(() => ({ calls: window.__receiptUi.calls, uploads: window.__receiptUi.uploads, reloads: window.__receiptUi.reloads }));
 assert.deepEqual(state, { calls: [['project-receipt-ui', 'approval-b']], uploads: 0, reloads: 0 });
 await expect(row(page).locator('.rt-job-pending')).toHaveText('pending');
}
test('verified receipt uses only the clicked approval and preserves the pending local job', async page => {
 assert.equal(await control(page).count(), 1, 'Existing approved jobs need a separate read-only receipt control');
 await control(page).click();
 await page.waitForFunction(() => window.__receiptUi.calls.length === 1);
 await expect(control(page)).toBeDisabled();
 await expect(page.locator('.rt-outbox .rt-section-heading button')).toBeDisabled();
 await page.evaluate(() => window.__receiptUi.settle.resolve({ status: 'verified', jobId: 'approval-b' }));
 await expect(page.locator('.rt-status')).toContainText('Server receipt verified');
 await expect(page.locator('.rt-status')).toContainText('No upload or local job update was performed');
 await expect(control(page)).toBeEnabled();
 await assertReadOnly(page);
});

test('missing receipt is inconclusive and never triggers a sync or local state rewrite', async page => {
 await control(page).click();
 await page.waitForFunction(() => window.__receiptUi.calls.length === 1);
 await page.evaluate(() => window.__receiptUi.settle.resolve({ status: 'missing', jobId: 'approval-b' }));
 await expect(page.locator('.rt-status')).toContainText('No server receipt found');
 await expect(page.locator('.rt-status')).toContainText('Write outcome remains unknown');
 await expect(page.locator('.rt-status')).toContainText('No upload was started');
 await expect(control(page)).toBeEnabled();
 await assertReadOnly(page);
});

test('receipt error stays visible without exposing backend details or refreshing local state', async page => {
 await control(page).click();
 await page.waitForFunction(() => window.__receiptUi.calls.length === 1);
 await page.evaluate(() => window.__receiptUi.settle.reject(new Error('Sensitive test-only backend detail that must never be displayed')));
 await expect(page.getByRole('alert')).toContainText('Write outcome remains unknown');
 await expect(page.getByRole('alert')).toContainText('No upload was started');
 await expect(page.getByRole('alert')).not.toContainText('Sensitive test-only');
 await expect(control(page)).toBeEnabled();
 await assertReadOnly(page);
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 await expect(page.getByRole('alert')).toBeVisible();
});

try {
 await server.listen();
 const address = server.httpServer.address();
 const origin = `http://127.0.0.1:${address.port}`;
 browser = await chromium.launch({ channel: 'chrome', headless: true });
 for (const { name, run } of tests) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('request', request => { if (!request.url().startsWith(origin)) externalRequests.push(request.url()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
   await page.goto(`${origin}/receipt-ui.html`);
   await page.locator('.rt-sharing').waitFor();
   await run(page);
   results.push({ name, passed: true });
   console.log(`PASS ${name}`);
  } finally { await context.close(); }
 }
 assert.deepEqual(externalRequests, [], 'UI fixture must never contact Firebase or other external services');
 assert.deepEqual(pageErrors, []);
} catch (error) {
 console.error(error);
 process.exitCode = 1;
} finally {
 if (browser) await browser.close();
 await server.close();
 await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
 await writeFile(new URL('../reports/receipt-ui.local.json', import.meta.url), JSON.stringify({ evidence: 'ISOLATED UI TEST DOUBLES ONLY; NOT LIVE FIRESTORE ACCEPTANCE', passed: results.length, results, externalRequests, pageErrors, exitCode: process.exitCode ?? 0 }, null, 2));
}
