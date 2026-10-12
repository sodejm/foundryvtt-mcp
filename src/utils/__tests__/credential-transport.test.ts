import { describe, expect, it } from 'vitest';
import {
  assertProtectedCredentialTransport,
  hasProtectedCredentialTransport,
} from '../credential-transport.js';

describe('credential transport policy', () => {
  it.each([
    'https://remote.test',
    'https://192.168.1.100/foundry',
    'http://localhost:30001',
    'http://LOCALHOST/foundry',
    'http://127.0.0.1:3010/',
    'http://[::1]:30001',
  ])('accepts %s', (url) => {
    expect(hasProtectedCredentialTransport(url)).toBe(true);
  });
  it.each([
    'http://remote.test',
    'http://192.168.1.100',
    'http://host.docker.internal',
    'http://localhost.',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://0177.0.0.1',
    'http://[0:0:0:0:0:0:0:1]',
    'https://user:transport-secret@remote.test',
    'https://@remote.test',
    'http://localhost?transport-secret',
    'https://remote.test#transport-secret',
    'https://remote.test?',
    'https://remote.test#',
    ' http://localhost',
    'http:\\localhost',
    'not a URL',
    'ftp://localhost',
  ])('rejects %s without echoing supplied values', (url) => {
    expect(hasProtectedCredentialTransport(url)).toBe(false);
    expect(() => assertProtectedCredentialTransport(url)).toThrow('HTTPS');
    try {
      assertProtectedCredentialTransport(url);
    } catch (error) {
      expect(String(error)).not.toContain('transport-secret');
    }
  });
  it('allows ordinary request query parameters only at the request boundary', () => {
    expect(() =>
      assertProtectedCredentialTransport('https://remote.test/actors?query=test', true),
    ).not.toThrow();
    expect(() =>
      assertProtectedCredentialTransport('http://remote.test/actors?query=test', true),
    ).toThrow();
    expect(() => assertProtectedCredentialTransport('https://remote.test/#secret', true)).toThrow();
  });
});
