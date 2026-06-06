import fs from 'fs';
import path from 'path';

/** Absolute path to the repo-root `/fixtures` directory shared by all platforms. */
export const FIXTURES_DIR = path.join(__dirname, '../../../../fixtures');

export function loadFixture<T>(file: string): T {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
  return JSON.parse(raw) as T;
}
