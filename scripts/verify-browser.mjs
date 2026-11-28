import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.RELAYTRACE_URL || 'http://localhost:5173/diagnostics';
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext();
const page = await context.newPage();
const failures = [];
page.on('pageerror', () => failures.push('Browser page error (details suppressed to avoid config disclosure)'));
try {
  const response = await page.goto(url);
  if (response?.status() !== 200) throw new Error('Feasibility page did not return HTTP 200');
  await page.getByRole('heading', { name: 'Local inference feasibility' }).waitFor();
  const readiness = await page.locator('#readiness').innerText();
  const report = { chrome: browser.version(), profile: 'isolated-automation-profile', readiness, pageErrors: failures };
  if (process.argv.includes('--probe')) {
    await page.getByRole('button', { name: 'Run genuine local inference', exact: true }).click();
    await page.waitForFunction(() => ['passed', 'failed'].includes(document.querySelector('#local-result')?.getAttribute('data-status')), undefined, { timeout: 180000 });
    report.localResult = await page.locator('#local-result').innerText();
    report.localStatus = await page.locator('#local-result').getAttribute('data-status');
  }
  await mkdir('reports', { recursive: true });
  await writeFile('reports/browser.local.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
  else if (report.localStatus === 'failed') process.exitCode = 2;
} finally { await context.close(); await browser.close(); }
