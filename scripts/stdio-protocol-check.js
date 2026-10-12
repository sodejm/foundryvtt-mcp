import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';

/** Exercise an installed package with raw MCP frames, independently of SDK parsing. */
export async function verifyInstalledStdio({ consumer, serverPath }) {
  const fixture = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ world: 'protocol-fixture' }));
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  try {
    for (const level of [undefined, 'debug']) {
      const canary = `private-journal-canary-${level ?? 'default'}`;
      const unknownName = `untrusted-tool-label-${level ?? 'default'}`;
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('FOUNDRY_') || key === 'LOG_LEVEL') delete env[key];
      }
      Object.assign(env, {
        FOUNDRY_URL: `http://127.0.0.1:${fixture.address().port}`,
        FOUNDRY_API_KEY: 'fixture-private-key',
        FOUNDRY_ALLOW_PRIVILEGED_ACCOUNT: 'true',
        FOUNDRY_WRITE_ENABLED: 'false',
        NODE_ENV: 'test',
      });
      if (level) env.LOG_LEVEL = level;
      const child = spawn(process.execPath, [serverPath], {
        cwd: consumer, env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close');
      let stdout = '';
      let stderr = '';
      let buffer = '';
      let protocolError;
      const replies = new Map();
      const pending = new Map();
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const frame = JSON.parse(line);
            assert.equal(frame.jsonrpc, '2.0');
            if (frame.id !== undefined) {
              replies.set(frame.id, frame);
              pending.get(frame.id)?.(frame);
            }
          } catch (error) { protocolError = error; }
        }
      });
      async function request(id, method, params) {
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`MCP response timeout: ${method}`)), 10000);
          pending.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        return response;
      }
      try {
        const initialized = await request(1, 'initialize', {
          protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'pack-protocol-check', version: '1' },
        });
        assert.ok(initialized.result?.serverInfo);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        assert.ok((await request(2, 'tools/list', {})).result?.tools.length);
        const journal = await request(3, 'tools/call', {
          name: 'create_journal_entry',
          arguments: { name: canary, pages: [{ name: canary, content: canary }] },
        });
        assert.ok(journal.error || journal.result?.isError, 'journal write must be rejected');
        const unknown = await request(4, 'tools/call', {
          name: unknownName, arguments: { password: canary, content: canary },
        });
        assert.ok(unknown.error || unknown.result?.isError, 'unknown tool must be rejected');
        const roll = await request(6, 'tools/call', {
          name: 'roll_dice', arguments: { formula: '1d1', engine: 'local' },
        });
        assert.equal(roll.result?.structuredContent?.total, 1, 'legitimate local roll must succeed');
        assert.ok((await request(5, 'resources/read', { uri: 'foundry://missing-resource' })).error);
      } finally {
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
        await closed;
        clearTimeout(killTimer);
      }
      assert.ifError(protocolError);
      assert.equal(buffer, '', 'stdout contains an incomplete protocol frame');
      assert.equal(replies.size, 6);
      assert.ok(stderr.includes('Tool execution completed {"tool":"roll_dice"}'));
      assert.ok(stderr.includes('Tool execution failed: {"tool":"create_journal_entry"}') || stderr.includes('Tool execution rejected {"tool":"create_journal_entry"}'));
      assert.ok(stderr.includes('FoundryVTT MCP Server starting...'));
      assert.ok(stderr.includes('INFO:'), 'default operational logging must be exercised');
      assert.ok(stderr.includes('ERROR:'), 'failure logging must be exercised');
      if (level) assert.ok(stderr.includes('DEBUG:'), 'debug routing must be exercised');
      assert.ok(!stderr.includes(unknownName), 'caller-supplied tool name leaked into diagnostics');
      for (const secret of [canary, 'fixture-private-key']) {
        assert.ok(!stdout.includes(secret), 'private fixture leaked into protocol output');
        assert.ok(!stderr.includes(secret), 'private fixture leaked into diagnostics');
      }
      console.log(`✅ Installed MCP stdio is protocol-only; private canaries absent (${level ?? 'default'})`);
    }
  } finally {
    await new Promise((resolve) => fixture.close(resolve));
  }
}
