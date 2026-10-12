import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupWizard } from '../../../scripts/setup-wizard.js';
import { writePrivateEnvFile } from '../private-env-file.js';

vi.mock('readline', () => ({ createInterface: () => ({ close: vi.fn() }) }));

const credential = 'private-env-synthetic-secret';
const content = `FOUNDRY_API_KEY=${credential}\n`;
let directory: string;
let destination: string;
let originalUmask: number;

beforeEach(() => {
  originalUmask = process.umask(0o022);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-env-test-'));
  destination = path.join(directory, '.env');
});
afterEach(() => {
  vi.restoreAllMocks();
  process.umask(originalUmask);
  fs.rmSync(directory, { recursive: true, force: true });
});

function expectSaved(): void {
  expect(fs.readFileSync(destination, 'utf8')).toBe(content);
  if (process.platform !== 'win32') {
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  }
  expect(fs.readdirSync(directory)).toEqual(['.env']);
}

describe('private configuration replacement', () => {
  it.each([0o022, 0o000, 0o077, 0o777])('creates private credentials with umask %i', (mask) => {
    process.umask(mask);
    writePrivateEnvFile(destination, content);
    expectSaved();
  });

  it.each([0o644, 0o600])('replaces an existing mode %i file privately', (mode) => {
    fs.writeFileSync(destination, 'previous configuration', { mode });
    writePrivateEnvFile(destination, content);
    expectSaved();
  });

  it.each([false, true])('rejects destination symlinks (dangling: %s)', (dangling) => {
    const victim = path.join(directory, 'victim');
    if (!dangling) {
      fs.writeFileSync(victim, 'untouched');
    }
    fs.symlinkSync(victim, destination);
    expect(() => writePrivateEnvFile(destination, content)).toThrow('Unable to save .env securely');
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(victim)).toBe(!dangling);
    if (!dangling) {
      expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    }
    expect(fs.readdirSync(directory).some((name) => name.startsWith('.env-'))).toBe(false);
  });

  it('rejects nonregular destinations', () => {
    fs.mkdirSync(destination);
    expect(() => writePrivateEnvFile(destination, content)).toThrow('Unable to save .env securely');
    expect(fs.statSync(destination).isDirectory()).toBe(true);
    expect(fs.readdirSync(directory)).toEqual(['.env']);
  });

  it('protects existing hardlinked credentials without changing their other reference contents', () => {
    const victim = path.join(directory, 'victim');
    fs.writeFileSync(victim, 'untouched', { mode: 0o644 });
    fs.linkSync(victim, destination);
    writePrivateEnvFile(destination, content);
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    expect(fs.readFileSync(destination, 'utf8')).toBe(content);
    if (process.platform !== 'win32') {
      expect(fs.statSync(victim).mode & 0o777).toBe(0o600);
      expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    'openSync',
    'fchmodSync',
    'writeFileSync',
    'fsyncSync',
    'closeSync',
    'renameSync',
  ] as const)('preserves the previous file and cleans up after %s fails', (operation) => {
    fs.writeFileSync(destination, 'previous configuration', { mode: 0o644 });
    const original = fs[operation];
    const mock = vi.spyOn(fs, operation);
    if (
      process.platform !== 'win32' &&
      (operation === 'openSync' || operation === 'fchmodSync' || operation === 'closeSync')
    ) {
      mock.mockImplementationOnce(original as never);
    }
    mock.mockImplementationOnce(() => {
      throw new Error(credential);
    });
    let failure: unknown;
    try {
      writePrivateEnvFile(destination, content);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('Unable to save .env securely');
    expect(String(failure)).not.toContain(credential);
    expect(fs.readFileSync(destination, 'utf8')).toBe('previous configuration');
    if (process.platform !== 'win32') {
      expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(directory)).toEqual(['.env']);
  });

  it.skipIf(process.platform === 'win32').each(['openSync', 'fstatSync', 'fchmodSync'] as const)(
    'fails before writing new credentials when existing-file %s fails',
    (operation) => {
      fs.writeFileSync(destination, 'previous configuration', { mode: 0o644 });
      vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw new Error(credential);
      });
      expect(() => writePrivateEnvFile(destination, content)).toThrow(
        'Unable to save .env securely',
      );
      expect(fs.readFileSync(destination, 'utf8')).toBe('previous configuration');
      expect(fs.readdirSync(directory)).toEqual(['.env']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'never follows a symlink while protecting existing credentials',
    () => {
      const victim = path.join(directory, 'victim');
      fs.writeFileSync(victim, 'untouched', { mode: 0o644 });
      fs.writeFileSync(destination, 'previous configuration', { mode: 0o644 });
      const open = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementationOnce((file, flags, mode) => {
        fs.unlinkSync(destination);
        fs.symlinkSync(victim, destination);
        return open(file, flags, mode);
      });
      expect(() => writePrivateEnvFile(destination, content)).toThrow(
        'Unable to save .env securely',
      );
      expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
      expect(fs.statSync(victim).mode & 0o777).toBe(0o644);
      expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(directory).sort()).toEqual(['.env', 'victim']);
    },
  );

  it('removes partial credential output when a fresh save fails', () => {
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file) => {
      write(file, credential.slice(0, 8));
      throw new Error(credential);
    });
    expect(() => writePrivateEnvFile(destination, content)).toThrow('Unable to save .env securely');
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('rejects a symlink introduced before the final destination check', () => {
    const victim = path.join(directory, 'victim');
    fs.writeFileSync(victim, 'untouched');
    const close = fs.closeSync;
    vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
      close(fd);
      fs.symlinkSync(victim, destination);
    });
    expect(() => writePrivateEnvFile(destination, content)).toThrow('Unable to save .env securely');
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(directory).sort()).toEqual(['.env', 'victim']);
  });

  it('never follows a symlink introduced after the final destination check', () => {
    const victim = path.join(directory, 'victim');
    fs.writeFileSync(victim, 'untouched');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, target) => {
      fs.symlinkSync(victim, destination);
      rename(source, target);
    });
    writePrivateEnvFile(destination, content);
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    expect(fs.lstatSync(destination).isFile()).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe(content);
  });

  it('does not report a committed save as failed when temporary directory cleanup fails', () => {
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error(credential);
    });
    writePrivateEnvFile(destination, content);
    expect(fs.readFileSync(destination, 'utf8')).toBe(content);
    const leftovers = fs.readdirSync(directory).filter((name) => name.startsWith('.env-'));
    expect(leftovers).toHaveLength(1);
    expect(fs.readdirSync(path.join(directory, leftovers[0]))).toEqual([]);
  });
});

describe('setup wizard configuration save', () => {
  it.each([
    'api-key',
    'credentials',
  ])('preserves the %s setup flow without echoing secrets', async (authMethod) => {
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(directory, '.env.example'),
      'FOUNDRY_URL=old\nFOUNDRY_API_KEY=old\nFOUNDRY_USERNAME=old\nFOUNDRY_PASSWORD=old\nCACHE_ENABLED=true\n',
    );
    const wizard = new SetupWizard();
    Reflect.set(wizard, 'config', {
      foundryUrl: 'http://127.0.0.1:30001',
      authMethod,
      apiKey: credential,
      username: 'synthetic-user',
      password: credential,
    });
    await Reflect.get(wizard, 'generateEnvFile').call(wizard);
    const saved = fs.readFileSync(destination, 'utf8');
    expect(saved).toContain('FOUNDRY_URL=http://127.0.0.1:30001');
    expect(saved).toContain('CACHE_ENABLED=true');
    expect(saved).toContain('# Generated by setup wizard on');
    if (authMethod === 'api-key') {
      expect(saved).toContain(`FOUNDRY_API_KEY=${credential}`);
      expect(saved).not.toContain('FOUNDRY_PASSWORD');
      expect(saved).not.toContain('FOUNDRY_USERNAME');
    } else {
      expect(saved).toContain(`FOUNDRY_PASSWORD=${credential}`);
      expect(saved).toContain('FOUNDRY_USERNAME=synthetic-user');
      expect(saved).not.toContain('FOUNDRY_API_KEY');
    }
    if (process.platform !== 'win32') {
      expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(logs.mock.calls)).not.toContain(credential);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error(credential);
    });
    await expect(Reflect.get(wizard, 'generateEnvFile').call(wizard)).rejects.toThrow(
      'Unable to save .env securely',
    );
    expect(fs.readFileSync(destination, 'utf8')).toBe(saved);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(credential);
  });
});
