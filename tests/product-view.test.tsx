import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { canCommit, draftFromText, validatePhoto, ProductShell } from '../src/ui/ProductApp';

it('caps the project title input at the 120-character storage and cloud limit', () => {
  const source = readFileSync(new URL('../src/ui/ProductApp.tsx', import.meta.url), 'utf8');
  const titleInput = source.match(/<input\b[^>]*\bname="title"[^>]*\/>/)?.[0];
  expect(titleInput).toBeDefined();
  expect(titleInput).toContain('maxLength={120}');
});

it('routes the project sharing sync action with an explicit project scope', () => {
  const source = readFileSync(new URL('../src/ui/ProductApp.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('async function sync()');
  const end = source.indexOf('function download()', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const handler = source.slice(start, end);
  // Boundary regression: the optional global adapter API must never be the UI default.
  expect(handler).toContain('await syncApprovedJobs(project.id)');
  expect(source).not.toContain('across all projects');
  expect(source).not.toContain('across projects');
  expect(source).toContain("only this project's previously approved pending or failed jobs");
});

it('renders honest local-first loading and acceptance status without running inference', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ProductShell)));
  expect(html).toContain('Opening local ledger');
  expect(html).toContain('pending verification');
  expect(html).toContain('Nothing shared automatically');
  expect(html).toContain('href="/diagnostics"');
  expect(html).not.toContain('phase 0');
});

describe('capture guardrails', () => {
  it('rejects non-image and oversized photos without altering a valid image', () => {
    expect(validatePhoto({ type: 'image/png', size: 8 * 1024 * 1024 })).toBe('');
    expect(validatePhoto({ type: 'image/jpeg', size: 8 * 1024 * 1024 + 1 })).toMatch(/8 MB/);
    expect(validatePhoto({ type: 'image/svg+xml', size: 100 })).toMatch(/PNG or JPEG/);
  });
  it('requires explicit confirmation, a source, and recorded content before commit', () => {
    expect(canCommit(false, 'manual', 'A note', draftFromText({}))).toBe(false);
    expect(canCommit(true, null, 'A note', draftFromText({}))).toBe(false);
    expect(canCommit(true, 'manual', '', draftFromText({}))).toBe(false);
    expect(canCommit(true, 'manual', 'A note', draftFromText({}))).toBe(true);
    expect(canCommit(true, 'manual', '', draftFromText({}), true)).toBe(true);
    expect(canCommit(true, 'manual', '', draftFromText({ observation: 'typed fact' }))).toBe(false);
  });
  it('preserves entered facts as lines without inventing missing fields', () => {
    const draft = draftFromText({ observation: '  Coil label unreadable\n\n No power applied ', next_check: 'Read label' });
    expect(draft.observation).toEqual(['Coil label unreadable', 'No power applied']);
    expect(draft.attempted).toEqual([]);
    expect(draft.next_check).toEqual(['Read label']);
    expect(Object.keys(draft)).toHaveLength(6);
  });
});
