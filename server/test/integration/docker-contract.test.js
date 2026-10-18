import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anonymous } from '../helpers.js';

// The Docker files are only exercised when someone builds the image, so these tests keep them honest:
// the health URL they poll must exist on the real server, and the image must contain what server.js loads.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('health endpoint', () => {
  it('answers 200 with an ok status (this is what Docker and the watchdog poll)', async () => {
    const res = await anonymous().get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('connected');
  });
});

describe('Docker files', () => {
  it('poll URLs that the server really serves', async () => {
    const polled = [read('docker-entrypoint.sh'), read('docker-compose.yml')]
      .flatMap((text) => [...text.matchAll(/(?:localhost|127\.0\.0\.1):3000(\/[A-Za-z0-9/_-]*)/g)].map((m) => m[1]));
    expect(polled.length).toBeGreaterThanOrEqual(2);
    for (const urlPath of new Set(polled)) {
      const res = await anonymous().get(urlPath);
      expect(res.status, `${urlPath} must exist on the server`).toBe(200);
    }
  });

  it('copy everything server.js requires at start-up into the image', () => {
    const dockerfile = read('Dockerfile');
    const required = [...fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'latin1').matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(5);
    for (const target of new Set(required)) {
      const [first] = target.split('/');
      const isDir = target.includes('/');
      const expected = isDir ? `COPY server/${first}/` : `COPY server/${first}.js`;
      expect(dockerfile, `Dockerfile must contain "${expected}" for require('./${target}')`).toContain(expected);
    }
  });

  it('keep the entrypoint script on Unix line endings', () => {
    expect(read('.gitattributes')).toMatch(/docker-entrypoint\.sh\s+text\s+eol=lf/);
    expect(read('Dockerfile')).toMatch(/sed -i 's\/\\r\$\/\/' \/docker-entrypoint\.sh/);
  });
});
