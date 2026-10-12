import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runIntegrationDocker } from '../../scripts/integration-docker.mjs';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-harness-test-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Docker integration lifecycle', () => {
  it('generates distinct private secrets and projects without forwarding inherited keys', async () => {
    const cwd = await fixture();
    await writeFile(
      join(cwd, '.env.integration'),
      'FOUNDRY_ADMIN_KEY=legacy-key\nFOUNDRY_TEST_PORT=30022\nCUSTOM_OPTION=preserved\n',
    );
    const keys: string[] = [];
    const projects: string[] = [];
    const paths: string[] = [];
    for (let i = 0; i < 2; i++) {
      const calls: string[][] = [];
      const status = await runIntegrationDocker({
        cwd,
        env: { FOUNDRY_ADMIN_KEY: 'inherited-key', FOUNDRY_TEST_SECRET_FILE: '/unowned' },
        testCommand: ['test-runner'],
        runCommand: async (args, options) => {
          calls.push(args);
          const path = options.env.FOUNDRY_TEST_SECRET_FILE;
          expect(options.env.FOUNDRY_ADMIN_KEY).toBeUndefined();
          expect(options.env.FOUNDRY_URL).toBe('http://127.0.0.1:30022');
          expect(options.env.CUSTOM_OPTION).toBe('preserved');
          expect(path).not.toBe('/unowned');
          expect(statSync(path).mode & 0o777).toBe(0o600);
          expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
          const key = JSON.parse(readFileSync(path, 'utf8')).foundry_admin_key;
          expect(key).toMatch(/^[0-9a-f]{64}$/);
          expect(args.join(' ')).not.toContain(key);
          expect(Object.values(options.env)).not.toContain(key);
          if (args.includes('up')) {
            keys.push(key);
            paths.push(path);
            projects.push(args[3]);
          }
          return 0;
        },
      });
      expect(status).toBe(0);
      expect(calls).toHaveLength(3);
      expect(calls[2].slice(-3)).toEqual(['down', '-v', '--remove-orphans']);
      expect(existsSync(paths[i])).toBe(false);
    }
    expect(keys[0]).not.toBe(keys[1]);
    expect(projects[0]).not.toBe(projects[1]);
  });

  it.each([
    [9, 0, 0, 9],
    [0, 7, 0, 7],
    [0, 0, 8, 8],
    [0, 7, 8, 7],
  ])('preserves startup/test/cleanup statuses %s/%s/%s', async (up, test, down, expected) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[][] = [];
    let secret = '';
    const status = await runIntegrationDocker({
      cwd: await fixture(),
      env: {},
      testCommand: ['test-runner'],
      runCommand: async (args, options) => {
        calls.push(args);
        secret = options.env.FOUNDRY_TEST_SECRET_FILE;
        return args.includes('up') ? up : args.includes('down') ? down : test;
      },
    });
    expect(status).toBe(expected);
    expect(calls).toHaveLength(up ? 2 : 3);
    expect(calls.at(-1)).toContain('down');
    expect(existsSync(secret)).toBe(false);
  });

  it('cleans the project and secret when test execution throws', async () => {
    const calls: string[][] = [];
    let secret = '';
    await expect(
      runIntegrationDocker({
        cwd: await fixture(),
        env: {},
        testCommand: ['test-runner'],
        runCommand: async (args, options) => {
          calls.push(args);
          secret = options.env.FOUNDRY_TEST_SECRET_FILE;
          if (args[0] === 'test-runner') {
            throw new Error('failed spawn');
          }
          return 0;
        },
      }),
    ).rejects.toThrow('failed spawn');
    expect(calls.at(-1)).toContain('down');
    expect(existsSync(secret)).toBe(false);
  });

  it.each([
    '0',
    '65536',
    '30001:30000',
    'abc',
  ])('rejects invalid port %s before startup', async (port) => {
    const runCommand = vi.fn();
    await expect(
      runIntegrationDocker({ cwd: await fixture(), env: { FOUNDRY_TEST_PORT: port }, runCommand }),
    ).rejects.toThrow('FOUNDRY_TEST_PORT');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('tears down after %s during startup', async (signal) => {
    const cwd = await fixture();
    const executable = join(cwd, 'docker');
    const log = join(cwd, 'events.jsonl');
    const descendant = join(cwd, 'descendant.pid');
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.EVENT_LOG, JSON.stringify({args:process.argv.slice(2), secret:process.env.FOUNDRY_TEST_SECRET_FILE})+'\\n');\nif(process.argv.includes('up')) { const grandchild = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.env.DESCENDANT_PID,String(process.pid)); setInterval(()=>{},1000);"], {stdio:'ignore'}); setInterval(()=>{},1000); }\n`,
    );
    await chmod(executable, 0o700);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../scripts/integration-docker.mjs', import.meta.url))],
      {
        cwd,
        env: {
          ...process.env,
          PATH: `${cwd}:${process.env.PATH}`,
          EVENT_LOG: log,
          DESCENDANT_PID: descendant,
        },
        stdio: 'pipe',
      },
    );
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      const deadline = Date.now() + 5000;
      while ((!existsSync(log) || !existsSync(descendant)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(log)).toBe(true);
      expect(existsSync(descendant)).toBe(true);
      const descendantPid = Number(readFileSync(descendant, 'utf8'));
      child.kill(signal);
      expect(await exited).toBe(signal === 'SIGINT' ? 130 : 143);
      expect(() => process.kill(descendantPid, 0)).toThrow();
      const events = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toHaveLength(2);
      expect(events[1].args).toContain('down');
      expect(events[1].args[2]).toBe(events[0].args[2]);
      expect(existsSync(events[0].secret)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  }, 15000);
});
