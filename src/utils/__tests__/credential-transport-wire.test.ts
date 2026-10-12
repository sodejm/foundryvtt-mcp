import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AxiosInstance } from 'axios';
import { io } from 'socket.io-client';
import { afterEach, expect, it } from 'vitest';
import { authenticateFoundry, sessionSocketOptions } from '../../foundry/auth.js';
import { FoundryClient } from '../../foundry/client.js';

const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

it('never forwards REST API keys through redirects, including per-request overrides', async () => {
  let targetRequests = 0;
  const target = await listen(
    createServer((_, response) => {
      targetRequests++;
      response.end('{}');
    }),
  );
  let originKey: string | string[] | undefined;
  const origin = await listen(
    createServer((request, response) => {
      originKey = request.headers['x-api-key'];
      response.writeHead(302, { Location: target });
      response.end();
    }),
  );
  const client = new FoundryClient({ baseUrl: origin, apiKey: 'wire-api-key' });
  const http = Reflect.get(client, 'http') as AxiosInstance;
  await expect(http.get('/redirect', { maxRedirects: 3 })).rejects.toThrow();
  expect(originKey).toBe('wire-api-key');
  expect(targetRequests).toBe(0);
  await expect(http.get('http://foundry.example/override')).rejects.toThrow('require HTTPS');
  expect(targetRequests).toBe(0);
});

it('never follows join redirects carrying session cookies and passwords', async () => {
  let targetRequests = 0;
  const target = await listen(
    createServer((_, response) => {
      targetRequests++;
      response.end('{}');
    }),
  );
  let posted = '';
  let cookie: string | undefined;
  const origin = await listen(
    createServer((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(302, { 'Set-Cookie': 'session=wire-session; Path=/', Location: target });
        response.end();
      } else {
        cookie = request.headers.cookie;
        request.on('data', (chunk) => {
          posted += chunk;
        });
        request.on('end', () => {
          response.writeHead(302, { Location: target, 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ status: 'success' }));
        });
      }
    }),
  );
  expect(await authenticateFoundry(origin, 'abcdefghijklmnop', 'wire-password')).toMatchObject({
    session: 'wire-session',
  });
  expect(cookie).toBe('session=wire-session');
  expect(JSON.parse(posted).password).toBe('wire-password');
  expect(targetRequests).toBe(0);
});

it('keeps Socket.IO sessions on the original endpoint across redirect failures and reconnects', async () => {
  let targetRequests = 0;
  const targetServer = createServer((_, response) => {
    targetRequests++;
    response.end();
  });
  targetServer.on('upgrade', (_, socket) => {
    targetRequests++;
    socket.destroy();
  });
  const target = await listen(targetServer);
  let upgrades = 0;
  const originServer = createServer();
  originServer.on('upgrade', (request, socket) => {
    upgrades++;
    expect(request.headers.cookie).toBe('session=wire-session');
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    expect(requestUrl.searchParams.has('session')).toBe(false);
    expect(requestUrl.href.includes('wire-session')).toBe(false);
    socket.end(
      `HTTP/1.1 302 Found\r\nLocation: ${target.replace('http:', 'ws:')}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
  });
  const origin = await listen(originServer);
  const socket = io(origin, {
    ...sessionSocketOptions('wire-session'),
    reconnectionAttempts: 1,
    reconnectionDelay: 1,
    randomizationFactor: 0,
    timeout: 1000,
  });
  try {
    await new Promise<void>((resolve) => socket.io.once('reconnect_failed', resolve));
    expect(upgrades).toBe(2);
    expect(targetRequests).toBe(0);
  } finally {
    socket.disconnect();
  }
});
