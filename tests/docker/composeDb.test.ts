import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// docker-compose.db.yml ships as a deployment template. Its Postgres holds every
// server secret and the users table, so it must never be published on all
// interfaces or fall back to a well-known password.
describe('docker-compose.db.yml', () => {
  const composePath = path.resolve(__dirname, '../../docker-compose.db.yml');
  const raw = fs.readFileSync(composePath, 'utf8');
  const compose = yaml.load(raw) as {
    services: Record<string, { ports?: string[]; environment?: Record<string, string> }>;
  };

  it('publishes the Postgres port on loopback only', () => {
    const ports = compose.services.postgres.ports ?? [];
    for (const port of ports) {
      expect(port.startsWith('127.0.0.1:')).toBe(true);
    }
  });

  it('requires DB_PASSWORD instead of defaulting to a well-known value', () => {
    expect(raw).not.toContain('mcphub_password');
    expect(compose.services.postgres.environment?.POSTGRES_PASSWORD).toMatch(/\$\{DB_PASSWORD:\?/);
    expect(compose.services.mcphub.environment?.DB_URL).toMatch(/\$\{DB_PASSWORD:\?/);
  });
});
