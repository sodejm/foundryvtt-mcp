import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupWizard } from '../../../scripts/setup-wizard.js';

vi.mock('axios', () => {
  const request = Object.assign(vi.fn(), { get: vi.fn(), isAxiosError: () => false });
  return { default: request };
});
vi.mock('readline', () => ({ createInterface: () => ({ close: vi.fn() }) }));

const key = 'transport-secret-sentinel';
let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(axios.get).mockResolvedValue({ status: 200, data: {} });
  vi.mocked(axios).mockResolvedValue({ status: 200, data: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function wizard(url: string) {
  const instance = new SetupWizard();
  Reflect.set(instance, 'config', { foundryUrl: url, apiKey: key, authMethod: 'api-key' });
  return instance;
}
function call(instance: SetupWizard, method: string, ...args: unknown[]) {
  return Reflect.get(instance, method).apply(instance, args);
}

describe('setup transport boundary', () => {
  it.each([
    'http://foundry.example',
    'http://127.1',
    `https://user:${key}@foundry.example`,
  ])('rejects %s before all probes', async (url) => {
    const instance = wizard(url);
    await expect(call(instance, 'testConnectivity')).rejects.toThrow('require HTTPS');
    await expect(call(instance, 'testAuthentication')).rejects.toThrow('require HTTPS');
    expect(await call(instance, 'testUrl', url)).toBe(false);
    expect(call(instance, 'isValidUrl', url)).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.mock.calls)).not.toContain(key);
  });
  it.each([
    'http://localhost:30001',
    'https://foundry.example',
  ])('disables redirects on every probe for %s', async (url) => {
    const instance = wizard(url);
    expect(await call(instance, 'testConnectivity')).toBe(true);
    await call(instance, 'testAuthentication');
    expect(await call(instance, 'testUrl', url)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(3);
    for (const [, options] of vi.mocked(axios.get).mock.calls) {
      expect(options?.maxRedirects).toBe(0);
    }
    expect(axios.get).toHaveBeenCalledWith(
      `${url}/api/status`,
      expect.objectContaining({ headers: { 'x-api-key': key } }),
    );
  });
  it('does not echo credential-bearing request errors', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error(key));
    const instance = wizard('https://foundry.example');
    expect(await call(instance, 'testConnectivity')).toBe(false);
    await expect(call(instance, 'testAuthentication')).rejects.toThrow(
      'Authentication test failed',
    );
    expect(JSON.stringify(logs.mock.calls)).not.toContain(key);
  });
  it.each([
    301, 302, 307, 308,
  ])('accepts a %s connectivity response without following it', async (status) => {
    vi.mocked(axios.get).mockResolvedValue({ status, data: {} });
    const url = 'https://foundry.example';
    const instance = wizard(url);
    expect(await call(instance, 'testConnectivity')).toBe(true);
    expect(await call(instance, 'testUrl', url)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(2);
    for (const [, options] of vi.mocked(axios.get).mock.calls) {
      expect(options?.maxRedirects).toBe(0);
      expect(options?.headers).toBeUndefined();
    }
  });
  it.each([404, 500])('rejects an unexpected %s connectivity response', async (status) => {
    vi.mocked(axios.get).mockResolvedValue({ status, data: {} });
    const url = 'https://foundry.example';
    const instance = wizard(url);
    expect(await call(instance, 'testConnectivity')).toBe(false);
    expect(await call(instance, 'testUrl', url)).toBe(false);
  });
});

describe('diagnostic transport boundary', () => {
  async function diagnostics(url: string) {
    vi.stubEnv('FOUNDRY_URL', url);
    vi.stubEnv('FOUNDRY_API_KEY', key);
    vi.resetModules();
    return (await import('../../../scripts/diagnose-api.js')).runDiagnostics;
  }
  it('rejects unsafe URLs without logging them or making requests', async () => {
    const run = await diagnostics(`http://user:${key}@foundry.example`);
    await expect(run()).rejects.toThrow('require HTTPS');
    expect(axios).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.mock.calls)).not.toContain(key);
  });
  it.each([
    'http://127.0.0.1:30001',
    'https://foundry.example',
  ])('keeps credentials on the configured endpoint %s', async (url) => {
    const run = await diagnostics(url);
    await run();
    expect(axios).toHaveBeenCalledTimes(8);
    for (const [options] of vi.mocked(axios).mock.calls) {
      expect(options).toMatchObject({ maxRedirects: 0 });
    }
    expect(JSON.stringify(logs.mock.calls)).not.toContain(key);
  });
  it('reports redirects as failures and hides request errors', async () => {
    const run = await diagnostics('https://foundry.example');
    vi.mocked(axios)
      .mockResolvedValueOnce({ status: 302, data: {} })
      .mockRejectedValue(new Error(key));
    await run();
    expect(JSON.stringify(logs.mock.calls)).toContain('Failed: 8');
    expect(JSON.stringify(logs.mock.calls)).not.toContain(key);
  });
});
