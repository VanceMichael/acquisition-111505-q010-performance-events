export const initialState = () => ({ name: '教学演奏交付', revision: 1 });

import { readFile } from 'node:fs/promises';
export async function handle({ url, state, json, bytes }) {
  if (url.pathname === '/performances') { json(200, [{ recording: 'lesson-1', href: '/performances/lesson.mid' }]); return true; }
  if (url.pathname === '/performances/lesson.mid') { let raw = await readFile(new URL('../fixtures/lesson.mid', import.meta.url)); if (state.truncated) raw = raw.subarray(0, raw.length - 5); bytes(200, raw, 'audio/midi'); return true; }
  return false;
}
