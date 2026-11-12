import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const projectRoot = path.resolve(__dirname, '../..');
const uid = process.getuid?.() ?? 0;
// Permission checks are meaningless for root, which can write everything.
const asNonRoot = uid === 0 ? it.skip : it;

const writeExecutable = (file: string, body: string) =>
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

// Real coreutils/findutils for the scripts, resolved once from the host PATH.
const linkTool = (directory: string, tool: string) => {
  const found = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`${tool} not found on the host`);
  fs.symlinkSync(found, path.join(directory, tool));
};

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe('Docker entrypoint', () => {
  let directory: string;
  let bin: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-entrypoint-'));
    bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    writeExecutable(path.join(bin, 'npm'), 'exit 0');
    writeExecutable(path.join(bin, 'mcphub-migrate'), 'echo "migrate called: $*"');
    // Exercise the real entrypoint with an isolated equivalent of the container's
    // /app and /var. EUID is a read-only bash variable, so the root branches are
    // reached through FAKE_EUID.
    const script = fs
      .readFileSync(path.join(projectRoot, 'entrypoint.sh'), 'utf8')
      .replaceAll('/app/', `${directory}/`)
      .replaceAll('/var/', `${directory}/var/`)
      .replaceAll('${EUID}', '${FAKE_EUID:-$EUID}');
    fs.writeFileSync(path.join(directory, 'entrypoint.sh'), script);
  });

  afterEach(() => {
    // Restore write permission so the temporary tree can be removed.
    for (const p of [directory, path.join(directory, 'data')]) {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const run = (extraEnv: NodeJS.ProcessEnv = {}, command?: string[]): Result => {
    const env: NodeJS.ProcessEnv = {
      HOME: directory,
      BASH_ENV: '/dev/null',
      PATH: bin,
      ...extraEnv,
    };
    const result = spawnSync(
      '/bin/bash',
      [
        path.join(directory, 'entrypoint.sh'),
        ...(command ?? ['/bin/bash', '-c', 'printf "selected=%s" "$MCPHUB_SETTING_PATH"']),
      ],
      { env, encoding: 'utf8' },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const selected = (extraEnv: NodeJS.ProcessEnv = {}) => {
    const result = run(extraEnv);
    expect(result.status).toBe(0);
    return result.stdout.split('selected=')[1];
  };

  describe('settings path selection', () => {
    it('uses the data directory on a fresh installation', () => {
      expect(selected()).toBe(path.join(directory, 'data/mcp_settings.json'));
    });

    it('retains the legacy file even when a data directory configuration also exists', () => {
      fs.writeFileSync(path.join(directory, 'mcp_settings.json'), '{"users":[]}');
      fs.mkdirSync(path.join(directory, 'data'));
      fs.writeFileSync(path.join(directory, 'data/mcp_settings.json'), '{}');
      expect(selected()).toBe(path.join(directory, 'mcp_settings.json'));
      expect(fs.readFileSync(path.join(directory, 'mcp_settings.json'), 'utf8')).toBe(
        '{"users":[]}',
      );
    });

    it('honors an explicit path even with a legacy file present', () => {
      fs.writeFileSync(path.join(directory, 'mcp_settings.json'), '{}');
      const explicitPath = path.join(directory, 'data/mcp_settings.json');
      expect(selected({ MCPHUB_SETTING_PATH: explicitPath })).toBe(explicitPath);
    });
  });

  describe('as a non-root user', () => {
    asNonRoot('exits 1 with the migration commands when the data directory is not writable', () => {
      fs.mkdirSync(path.join(directory, 'data'), { mode: 0o555 });
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('selected=');
      expect(result.stderr).toContain(
        `ERROR: MCPHub runs as uid ${uid} and cannot write: ${directory}/data`,
      );
      // The harness maps /app to the temporary directory, messages included.
      expect(result.stderr).toContain(
        `docker run --rm --user 0:0 -v <volume>:${directory}/data <image> mcphub-migrate`,
      );
      expect(result.stderr).toContain(
        'docker compose run --rm --user 0:0 <service> mcphub-migrate',
      );
      expect(result.stderr).toContain('fsGroup: 10001 and fsGroupChangePolicy: OnRootMismatch');
      expect(result.stderr).toContain('sudo chown -R 10001:10001 ./data');
    });

    asNonRoot('exits 1 when the settings file is read-only', () => {
      fs.mkdirSync(path.join(directory, 'data'));
      fs.writeFileSync(path.join(directory, 'data/mcp_settings.json'), '{}', { mode: 0o444 });
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`cannot write: ${directory}/data/mcp_settings.json`);
    });

    asNonRoot('exits 1 for a legacy file mount whose sidecars cannot be created', () => {
      fs.mkdirSync(path.join(directory, 'data'));
      fs.writeFileSync(path.join(directory, 'mcp_settings.json'), '{}');
      fs.chmodSync(directory, 0o555);
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${directory} (to create mcp_settings.json.credentials.json)`,
      );
      expect(result.stderr).toContain(
        `${directory}/mcp_settings.json has to move into ${directory}/data`,
      );
    });

    asNonRoot('only needs a writable data directory in database mode', () => {
      fs.mkdirSync(path.join(directory, 'data'));
      const readOnly = path.join(directory, 'data/mcp_settings.json');
      fs.writeFileSync(readOnly, '{}', { mode: 0o444 });
      expect(selected({ DB_URL: 'postgresql://db/mcphub' })).toBe(readOnly);
      expect(selected({ USE_DB: 'true' })).toBe(readOnly);
      expect(run({ USE_DB: 'false', DB_URL: 'postgresql://db/mcphub' }).status).toBe(1);
    });

    asNonRoot('runs mcphub-migrate before any writability check', () => {
      fs.mkdirSync(path.join(directory, 'data'), { mode: 0o555 });
      const result = run({}, ['mcphub-migrate', '--dry-run']);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('migrate called: --dry-run\n');
      expect(result.stderr).toBe('');
    });

    asNonRoot('starts without a warning when everything is writable', () => {
      const result = run();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('says that MCPHUB_RUN_AS_ROOT no longer switches to root', () => {
      const result = run({ FAKE_EUID: '10001', MCPHUB_RUN_AS_ROOT: 'true' });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('MCPHUB_RUN_AS_ROOT=true no longer switches to root');
    });
  });

  describe('as root', () => {
    it('warns and continues outside the full variant', () => {
      const result = run({ FAKE_EUID: '0' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('selected=');
      expect(result.stderr).toContain('WARNING: MCPHub runs as root.');
      expect(result.stderr).toContain('mcphub-migrate');
    });

    it('does not warn when root is chosen with MCPHUB_RUN_AS_ROOT=true', () => {
      const result = run({ FAKE_EUID: '0', MCPHUB_RUN_AS_ROOT: 'true' });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('starts dockerd in the full variant without the root warning', () => {
      linkTool(bin, 'mkdir');
      fs.mkdirSync(path.join(directory, 'var/log'), { recursive: true });
      writeExecutable(path.join(bin, 'dockerd'), `echo "dockerd $*" > "${directory}/dockerd.args"`);
      writeExecutable(path.join(bin, 'docker'), 'exit 0');
      const result = run({ FAKE_EUID: '0' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Docker daemon started successfully');
      expect(result.stderr).toBe('');
      expect(fs.existsSync(path.join(directory, 'var/lib/docker'))).toBe(true);
    });

    it('does not start dockerd in the full variant when it is not root', () => {
      writeExecutable(path.join(bin, 'dockerd'), 'exit 1');
      const result = run({ FAKE_EUID: '10001' });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('dockerd is installed but the container runs as uid 10001');
      expect(result.stdout).not.toContain('starting dockerd');
    });
  });
});

describe('mcphub-migrate', () => {
  let directory: string;
  let bin: string;
  let data: string;
  let home: string;
  let chownLog: string;

  // The script is made runnable without root: the root check is disabled and
  // "root-owned" means "owned by the test user". chown is replaced by a stub
  // that records its arguments, so the selection, flags and summary are
  // checked here; the real ownership change is verified against the images.
  const install = (asRoot: boolean) => {
    let script = fs
      .readFileSync(path.join(projectRoot, 'mcphub-migrate.sh'), 'utf8')
      .replaceAll('/app/', `${directory}/app/`)
      .replaceAll('/home/mcphub', home)
      .replaceAll('/proc/self/mountinfo', path.join(directory, 'mountinfo'));
    if (asRoot) {
      script = script
        .replace('[ "${EUID}" -ne 0 ]', 'false')
        .replaceAll('-user 0 ', `-user ${uid} `);
    }
    fs.writeFileSync(path.join(bin, 'mcphub-migrate'), script, { mode: 0o755 });
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-migrate-'));
    bin = path.join(directory, 'bin');
    data = path.join(directory, 'app/data');
    home = path.join(directory, 'home');
    chownLog = path.join(directory, 'chown.log');
    fs.mkdirSync(bin);
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(path.join(home, '.npm'), { recursive: true });
    for (const tool of ['find', 'cp', 'chmod', 'cat']) linkTool(bin, tool);
    writeExecutable(path.join(bin, 'chown'), `echo "$*" >> "${chownLog}"`);
    fs.writeFileSync(path.join(directory, 'mountinfo'), '');
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  const migrate = (...args: string[]): Result => {
    const result = spawnSync('/bin/bash', [path.join(bin, 'mcphub-migrate'), ...args], {
      env: { BASH_ENV: '/dev/null', PATH: bin },
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const chownCalls = () => (fs.existsSync(chownLog) ? fs.readFileSync(chownLog, 'utf8') : '');

  asNonRoot('refuses to run without root and explains how to run it', () => {
    install(false);
    const result = migrate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mcphub-migrate must run as root');
    expect(result.stderr).toContain('docker compose run --rm --user 0:0 <service> mcphub-migrate');
    expect(result.stderr).toContain('fsGroupChangePolicy: OnRootMismatch');
    expect(chownCalls()).toBe('');
  });

  it('rejects unknown arguments', () => {
    install(true);
    const result = migrate('--force');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument: --force');
  });

  it('lists the entries in a dry run and changes nothing', () => {
    install(true);
    fs.writeFileSync(path.join(data, 'mcp_settings.json'), '{}');
    fs.writeFileSync(path.join(data, 'mcp_settings.json.credentials.key'), 'k');
    const result = migrate('--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`would chown 10001:10001: ${data}\n`);
    expect(result.stdout).toContain(`would chown 10001:10001: ${data}/mcp_settings.json\n`);
    expect(result.stdout).toContain(
      `would chown 10001:10001: ${data}/mcp_settings.json.credentials.key\n`,
    );
    expect(result.stdout).toContain(
      'Summary (dry run, nothing changed): 3 entries would be handed',
    );
    expect(chownCalls()).toBe('');
  });

  it('chowns without following symlinks and stays on the data directory', () => {
    install(true);
    const outside = path.join(directory, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret'), 'x');
    fs.symlinkSync(outside, path.join(data, 'link'));
    const result = migrate();
    expect(result.status).toBe(0);
    const calls = chownCalls();
    expect(calls).toMatch(/^-h 10001:10001 /);
    expect(calls).toContain(`${data}/link`);
    expect(calls).not.toContain(outside);
    expect(result.stdout).toContain(`${data}: handed 2 root-owned entries to 10001:10001`);
    // HOME is not a mount here, so it is not scanned.
    expect(result.stdout).not.toContain(home);
  });

  it('also scans mounts at or below HOME', () => {
    install(true);
    fs.writeFileSync(path.join(home, '.npm', 'cached'), 'x');
    // mountinfo fields: id parent major:minor root mount-point options ...
    fs.writeFileSync(
      path.join(directory, 'mountinfo'),
      `1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / ${home}/.npm rw - ext4 /dev/x rw\n`,
    );
    const result = migrate('--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`would chown 10001:10001: ${home}/.npm/cached\n`);
    expect(result.stdout).toContain(`${home}/.npm: would hand 2 root-owned entries`);
  });

  it('treats mounts below the data directory as boundaries', () => {
    install(true);
    fs.writeFileSync(path.join(data, 'mcp_settings.json'), '{}');
    const hostDir = path.join(data, 'hostdir');
    fs.mkdirSync(hostDir);
    fs.writeFileSync(path.join(hostDir, 'f'), 'x');
    fs.writeFileSync(path.join(data, 'hostfile'), 'x');
    fs.writeFileSync(
      path.join(directory, 'mountinfo'),
      `1 0 0:1 / / rw - overlay overlay rw\n` +
        `2 1 0:2 /h/rootdir ${hostDir} rw - ext4 /dev/x rw\n` +
        `3 1 0:2 /h/rootfile ${data}/hostfile rw - ext4 /dev/x rw\n`,
    );

    const result = migrate('--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(`would chown 10001:10001: ${hostDir}`);
    expect(result.stdout).not.toContain(`would chown 10001:10001: ${data}/hostfile`);
    expect(result.stdout).toContain(`${hostDir}: a separate mount; it is not changed`);
    expect(result.stdout).toContain(`${data}/hostfile: a single file is mounted here`);
    expect(result.stdout).toContain('2 entries would be handed');

    const included = migrate('--dry-run', '--include-mounts');
    expect(included.status).toBe(0);
    // Each entry is listed once: the mount is pruned from the data scan.
    expect(included.stdout.split(`would chown 10001:10001: ${hostDir}/f\n`).length).toBe(2);
    expect(included.stdout).toContain(`${hostDir}: would hand 2 root-owned entries`);
    expect(included.stdout).not.toContain(`would chown 10001:10001: ${data}/hostfile`);
    expect(included.stdout).toContain('4 entries would be handed');

    const real = migrate();
    expect(real.status).toBe(0);
    expect(chownCalls()).not.toContain(hostDir);
    expect(chownCalls()).not.toContain('hostfile');
  });

  it('copies a legacy settings file mount into the data directory once', () => {
    install(true);
    const legacy = path.join(directory, 'app/mcp_settings.json');
    fs.writeFileSync(legacy, '{"users":[]}', { mode: 0o644 });
    fs.writeFileSync(`${legacy}.credentials.key`, 'key');

    const dry = migrate('--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(`would copy ${legacy} to ${data}/mcp_settings.json`);
    expect(fs.existsSync(path.join(data, 'mcp_settings.json'))).toBe(false);

    const first = migrate();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('mcphub-migrate does not change it');
    expect(first.stdout).toContain('2 legacy files copied');
    expect(first.stdout).toContain(`Next: remove the ${legacy} mount`);
    const copy = path.join(data, 'mcp_settings.json');
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"users":[]}');
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(data, 'mcp_settings.json.credentials.key'), 'utf8')).toBe(
      'key',
    );
    // The mounted (host) file is left exactly as it was.
    expect(fs.readFileSync(legacy, 'utf8')).toBe('{"users":[]}');
    expect(fs.statSync(legacy).mode & 0o777).toBe(0o644);

    fs.writeFileSync(copy, '{"changed":true}');
    const second = migrate();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already exists and is left unchanged');
    expect(second.stdout).toContain('0 legacy files copied');
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"changed":true}');
  });
});
