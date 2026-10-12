#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';

function command(args, { cwd, env, signal, quiet = false, timeout = 0 }) {
  return new Promise((resolveStatus) => {
    const child = spawn(args[0], args.slice(1), {
      cwd, env, stdio: quiet ? 'ignore' : 'inherit', detached: process.platform !== 'win32',
    });
    let killTimer;
    let stopping = false;
    let exitStatus;
    let finished = false;
    function kill(how) {
      try {
        if (process.platform === 'win32') child.kill(how);
        else process.kill(-child.pid, how);
      } catch { /* The process may already have exited. */ }
    }
    function stop() {
      if (stopping) return;
      stopping = true;
      if (process.platform === 'win32') {
        // Terminate descendants before their leader can exit and orphan them.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          .once('error', () => kill('SIGKILL'));
      } else kill('SIGTERM');
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        stopping = false;
        if (exitStatus !== undefined) done(exitStatus);
      }, 5000);
    }
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const timer = timeout ? setTimeout(stop, timeout) : undefined;
    function done(code) {
      if (finished) return;
      if (stopping) { exitStatus = code; return; }
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      resolveStatus(code);
    }
    child.once('error', () => done(127));
    child.once('exit', (code, exitSignal) => done(code ?? (exitSignal === 'SIGINT' ? 130 : 143)));
  });
}

/** Own exactly one Compose project and its temporary admin secret. */
export async function runIntegrationDocker({
  cwd = process.cwd(), env = process.env,
  composeFiles = ['docker-compose.test.yml'],
  testCommand = ['bun', 'run', 'test:integration', ...process.argv.slice(2)],
  runCommand = command,
} = {}) {
  const envPath = join(cwd, '.env.integration');
  const runEnv = { ...(existsSync(envPath) ? parse(readFileSync(envPath)) : {}), ...env };
  const port = runEnv.FOUNDRY_TEST_PORT ?? '30001';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('FOUNDRY_TEST_PORT must be a port between 1 and 65535');
  }
  // Never forward an inherited admin key or accept an inherited secret file.
  delete runEnv.FOUNDRY_ADMIN_KEY;
  const directory = await mkdtemp(join(tmpdir(), 'foundry-integration-'));
  let status = 1;
  let signalStatus;
  const controller = new AbortController();
  const onInterrupt = () => { signalStatus ??= 130; controller.abort(); };
  const onTerminate = () => { signalStatus ??= 143; controller.abort(); };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const project = `foundry-test-${randomBytes(12).toString('hex')}`;
  const compose = ['docker', 'compose', '--project-name', project,
    ...composeFiles.flatMap((file) => ['-f', file])];
  try {
    await chmod(directory, 0o700);
    const secretFile = join(directory, 'config.json');
    await writeFile(secretFile, JSON.stringify({ foundry_admin_key: randomBytes(32).toString('hex') }),
      { mode: 0o600, flag: 'wx' });
    runEnv.FOUNDRY_TEST_SECRET_FILE = secretFile;
    runEnv.FOUNDRY_TEST_PORT = port;
    runEnv.FOUNDRY_URL = `http://127.0.0.1:${Number(port)}`;
    status = await runCommand([...compose, 'up', '-d', '--wait'],
      { cwd, env: runEnv, signal: controller.signal, quiet: true });
    if (!status && !controller.signal.aborted) {
      status = await runCommand(testCommand, { cwd, env: runEnv, signal: controller.signal });
    } else if (!controller.signal.aborted) {
      console.error('Foundry Docker startup failed. Check the image and .env.integration configuration.');
    }
  } finally {
    // Teardown is attempted even after partial startup and is not aborted by the test signal.
    try {
      const cleanupStatus = await runCommand([...compose, 'down', '-v', '--remove-orphans'],
        { cwd, env: runEnv, quiet: true, timeout: 45000 });
      if (cleanupStatus) {
        console.error(`Foundry Docker teardown failed. Set FOUNDRY_TEST_SECRET_FILE=/dev/null and run docker compose --project-name ${project} with the same -f files and down -v --remove-orphans before reusing the port.`);
        status ||= cleanupStatus;
      }
    } finally {
      try { await rm(directory, { recursive: true, force: true }); }
      finally {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
      }
    }
  }
  return signalStatus ?? status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runIntegrationDocker(); }
  catch { console.error('Foundry Docker integration harness failed.'); process.exitCode = 1; }
}
