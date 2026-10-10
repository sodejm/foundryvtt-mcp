import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('integration runner credentials', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the Docker test user when credentials are unset', async () => {
    vi.stubEnv('FOUNDRY_USERNAME', undefined);
    vi.stubEnv('FOUNDRY_PASSWORD', undefined);

    const { default: config } = await import('../../vitest.integration.config.js');

    expect(config.test?.env?.FOUNDRY_USERNAME).toBe('test-user');
    expect(config.test?.env?.FOUNDRY_PASSWORD).toBe('test-password');
  });

  it('preserves explicit credentials including a blank local-world password', async () => {
    vi.stubEnv('FOUNDRY_USERNAME', 'Gamemaster');
    vi.stubEnv('FOUNDRY_PASSWORD', '');

    const { default: config } = await import('../../vitest.integration.config.js');

    expect(config.test?.env?.FOUNDRY_USERNAME).toBe('Gamemaster');
    expect(config.test?.env?.FOUNDRY_PASSWORD).toBe('');
  });
});
