#!/usr/bin/python3 -I
"""Root-owned SSH entrypoint; every operation executes as foundry-mcp, never root."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile

HOME = Path('/srv/foundry-mcp')
NODE = '/usr/local/libexec/foundry-mcp-node'
NPM = '/usr/local/libexec/foundry-mcp-npm'
ENTRY = HOME / 'app/node_modules/foundryvtt-mcp/dist/index.js'


def private(path, directory=False):
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Private owner-only path required')


def stop():
    """Only signal this account's exact MCP entrypoint, including concurrent clients."""
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            if len(args) > 1 and args[1] == os.fsencode(ENTRY):
                os.kill(int(proc.name), signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass


def main():
    account = pwd.getpwnam('foundry-mcp')
    if os.getuid() != account.pw_uid or os.getgid() != account.pw_gid or set(os.getgroups()) - {account.pw_gid}:
        raise ValueError('Dedicated account and private group required')
    os.umask(0o077)
    private(HOME, True)
    os.environ.clear()
    os.environ.update(HOME=str(HOME), PATH='/usr/local/bin:/usr/bin:/bin',
                      npm_config_cache=str(HOME / 'cache'), npm_config_userconfig='/dev/null',
                      npm_config_registry='https://registry.npmjs.org/',
                      npm_config_update_notifier='false')
    command = ORIGINAL_COMMAND
    for name in ('config', 'cache'):
        path = HOME / name
        path.mkdir(mode=0o700, exist_ok=True)
        private(path, True)
    os.chdir(HOME / 'config')
    lock = os.open(HOME / '.operation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    private(HOME / '.operation.lock')
    if command == 'stop':
        stop()
        return
    mode = fcntl.LOCK_SH if command in ('run', 'verify') else fcntl.LOCK_EX
    # Do not install, change credentials or remove files while clients are running.
    fcntl.flock(lock, mode | fcntl.LOCK_NB)
    if command == 'verify':
        private(HOME / 'config/.env')
        print(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), 'groups': os.getgroups(),
                          'homeMode': oct(HOME.stat().st_mode & 0o777),
                          'configMode': oct((HOME / 'config').stat().st_mode & 0o777),
                          'credentialMode': oct((HOME / 'config/.env').lstat().st_mode & 0o777)}))
    elif command == 'configure':
        destination = HOME / 'config/.env'
        if destination.exists() or destination.is_symlink():
            private(destination)
        data = sys.stdin.buffer.read(65537)
        if not data or len(data) > 65536 or b'\0' in data:
            raise ValueError('Configuration must be a nonempty dotenv file under 64 KiB')
        fd, temporary = tempfile.mkstemp(dir=HOME / 'config', prefix='.env-')
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(data)
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    elif command == 'run':
        private(HOME / 'config/.env')
        if not ENTRY.is_file():
            raise ValueError('Install the pinned package first')
        os.set_inheritable(lock, True)
        os.execve(NODE, [NODE, str(ENTRY)], dict(os.environ))
    elif command == 'remove':
        for name in ('app', 'cache', 'config'):
            shutil.rmtree(HOME / name)
    elif (match := re.fullmatch(r'install ([0-9]+\.[0-9]+\.[0-9]+) ([a-f0-9]{64})', command)):
        version, digest = match.groups()
        with tempfile.TemporaryDirectory(dir=HOME, prefix='.install-') as temporary:
            staging = Path(temporary)
            artifact = staging / 'release.tgz'
            hasher = hashlib.sha256()
            total = 0
            with artifact.open('wb') as output:
                while chunk := sys.stdin.buffer.read(65536):
                    total += len(chunk)
                    if total > 50 * 1024 * 1024:
                        raise ValueError('Release artifact exceeds 50 MiB')
                    hasher.update(chunk)
                    output.write(chunk)
            if hasher.hexdigest() != digest:
                raise ValueError('Release digest mismatch')
            with tarfile.open(artifact) as archive:
                metadata = archive.extractfile('package/package.json')
                if metadata is None:
                    raise ValueError('Missing package manifest')
                manifest = json.load(metadata)
            if manifest.get('name') != 'foundryvtt-mcp' or manifest.get('version') != version:
                raise ValueError('Pinned package name/version mismatch')
            target = staging / 'app'
            target.mkdir(mode=0o700)
            subprocess.run([NPM, 'install', '--prefix', str(target), '--ignore-scripts',
                            '--omit=dev', '--no-audit', '--no-fund', str(artifact)],
                           check=True, stdout=sys.stderr, stderr=sys.stderr)
            if not (target / 'node_modules/foundryvtt-mcp/dist/index.js').is_file():
                raise ValueError('Release has no built entrypoint')
            # Keep the previous installation if npm fails. Stop clients before upgrade.
            previous = HOME / 'app'
            backup = staging / 'previous'
            if previous.exists():
                os.rename(previous, backup)
            try:
                os.rename(target, previous)
            except OSError:
                if backup.exists():
                    os.rename(backup, previous)
                raise
    else:
        raise ValueError('Unsupported SSH command')


ORIGINAL_COMMAND = os.environ.get('SSH_ORIGINAL_COMMAND', '')
try:
    main()
except (OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError):
    # Never print supplied commands, configuration, or subprocess environment.
    print('Remote STDIO operation rejected; check command, private paths and active sessions.', file=sys.stderr)
    sys.exit(1)
