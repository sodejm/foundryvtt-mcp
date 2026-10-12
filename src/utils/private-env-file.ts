import fs from 'node:fs';
import path from 'node:path';

const SAVE_ERROR =
  'Unable to save .env securely. Check directory permissions and remove any .env symlink.';

function assertRegularDestination(destination: string): void {
  try {
    if (!fs.lstatSync(destination).isFile()) {
      throw new Error(SAVE_ERROR);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/** Atomically replace a regular .env in a trusted directory, using private POSIX modes. */
export function writePrivateEnvFile(destination: string, content: string): void {
  let temporaryDirectory: string | undefined;
  let descriptor: number | undefined;
  try {
    assertRegularDestination(destination);
    if (process.platform !== 'win32') {
      try {
        // Do not follow a symlink introduced after the destination check or block on a FIFO.
        descriptor = fs.openSync(
          destination,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      if (descriptor !== undefined) {
        if (!fs.fstatSync(descriptor).isFile()) {
          throw new Error(SAVE_ERROR);
        }
        // Protect existing credentials even if preparing or committing their replacement fails.
        fs.fchmodSync(descriptor, 0o600);
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
    }
    temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(destination), '.env-'));
    fs.chmodSync(temporaryDirectory, 0o700);
    const temporaryFile = path.join(temporaryDirectory, 'config');
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    // Restore owner access even when umask removes it, before writing credential bytes.
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertRegularDestination(destination);
    // Rename is the commit point; never unlink the old configuration to retry it.
    fs.renameSync(temporaryFile, destination);
  } catch {
    // Filesystem error messages can contain sensitive content or configuration paths.
    throw new Error(SAVE_ERROR);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* Preserve the primary failure. */
      }
    }
    if (temporaryDirectory !== undefined) {
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch {
        // A cleanup failure leaves a private directory, and cannot undo a committed rename.
      }
    }
  }
}
