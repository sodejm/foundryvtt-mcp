# Remote STDIO under a dedicated Linux account

The MCP executable uses STDIO. For a remote host, the client launches an authenticated
SSH process and exchanges MCP frames through that process's stdin/stdout. Each client
connection starts its own MCP process. Close clients and use the `stop` operation
below to ensure their remote processes exit before changing the installation.
There is no additional MCP HTTP listener. Local `bunx` and `npx` usage remains supported
without root.

Use a dedicated minimal Linux VM for this recipe. The qualified runtime is Node
26.5.0 on Debian bookworm with OpenSSH and Python 3. Docker is used only by the
qualification lab; the service account must have no Docker group or engine socket.
The Linux account `foundry-mcp` is separate from the dedicated Foundry API account
(for example `mcp-api`). Choose the latter's document permissions using the
[Foundry account matrix](account-permissions.md).

## One-time administrator provisioning

Install a verified Node runtime as root under `/usr/local/bin`, plus OpenSSH server
and Python 3 using the host's supported package manager. Verify the runtime's source
and release integrity before installing. Do not put a user-writable directory in
front of it in the service's PATH. The following administrator commands establish
one private account/group and a root-controlled SSH policy:

```sh
sudo useradd --create-home --home-dir /srv/foundry-mcp --shell /bin/sh --password '*' foundry-mcp
sudo chmod 700 /srv/foundry-mcp
sudo install -d -o root -g root -m 755 /usr/local/libexec
sudo ln -s /usr/local/bin/node /usr/local/libexec/foundry-mcp-node
sudo ln -s /usr/local/bin/npm /usr/local/libexec/foundry-mcp-npm
sudo install -o root -g root -m 755 deploy/remote-stdio/dispatch.py /usr/local/libexec/foundry-mcp-ssh
sudo install -o root -g root -m 644 deploy/remote-stdio/sshd.conf /etc/ssh/sshd_config.d/60-foundry-mcp.conf
```

Copy the deployment files from a reviewed repository revision. The OS account has
an unusable password, a shell only so sshd can execute the forced command, and only
its private primary group. Verify `id foundry-mcp`; remove any sudo, wheel, Docker,
or other supplementary membership and applicable sudoers rules. Use no shared group
unless a specific resource requires one; this dispatcher intentionally rejects any
supplementary group. It does not need access to Foundry's installation or world files.

Generate an operator Ed25519 SSH key on the client with a passphrase and store it in
that client's private SSH directory. Provision only its public key on the server:

```sh
sudo install -o root -g root -m 644 /dev/null /etc/ssh/foundry-mcp.keys
# Append "restrict " followed by the approved public key, using your administrator editor.
sudoedit /etc/ssh/foundry-mcp.keys
# Public keys must be readable by the account; only root can modify this file.
sudo /usr/sbin/sshd -t
sudo /usr/sbin/sshd -T -C user=foundry-mcp,host=client,addr=CLIENT_IP
sudo systemctl reload ssh
```

Check the effective policy includes `authenticationmethods publickey`,
`passwordauthentication no`, `kbdinteractiveauthentication no`, `permittty no`,
`permituserrc no`, `disableforwarding yes` and the forced dispatcher. The root-owned
key file prevents the service account from granting itself unrestricted SSH access.
Other global SSH settings (including existing `Match` blocks) can affect the result;
check the effective settings before enabling client access. `ForceCommand` alone
does not disable forwarding. The supplied policy additionally disables TCP, Unix
socket, agent and X11 forwarding, user RC execution, PTYs and tunnels. See the
[OpenSSH policy reference](https://man.openbsd.org/sshd_config) and
[authorized key restrictions](https://man.openbsd.org/sshd.8).

Require owner-only modes on other users' homes and unrelated application files on
this dedicated host. Unix account separation denies private files and privileged
operations; it does not conceal world-readable files or sandbox an npm dependency.
An SSH key holder can install code as `foundry-mcp` and therefore can access this
account's Foundry credentials. Treat it as authority to operate that service account.
A dedicated VM bounds the impact if the package or that key is compromised.

## Unprivileged installation and configuration

On the client, verify the server host key fingerprint through an independent
administrator channel. Pin it in a dedicated known-hosts file. Do not accept a new
key automatically or rely on an unauthenticated `ssh-keyscan` as verification. Configure
an SSH host alias, substituting the actual paths, hostname and port:

```sshconfig
Host foundry-mcp
    HostName YOUR_DEDICATED_HOST
    User foundry-mcp
    Port 22
    IdentityFile ~/.ssh/foundry-mcp
    IdentitiesOnly yes
    BatchMode yes
    StrictHostKeyChecking yes
    UserKnownHostsFile ~/.ssh/foundry-mcp-known-hosts
    RequestTTY no
    ForwardAgent no
    ClearAllForwardings yes
```

For a passphrase-protected key, load it into the client's local agent first; agent
forwarding stays disabled. Confirm the runtime release and package provenance through
your normal review process. Download an exact package version on the client, without
running lifecycle scripts, and calculate the reviewed artifact's digest:

```sh
umask 077
mkdir -p ./foundry-release
npm pack foundryvtt-mcp@1.5.3 --ignore-scripts --pack-destination ./foundry-release
sha256sum ./foundry-release/foundryvtt-mcp-1.5.3.tgz
# macOS: shasum -a 256 ./foundry-release/foundryvtt-mcp-1.5.3.tgz
ssh -T foundry-mcp 'install 1.5.3 SHA256_FROM_REVIEW' < ./foundry-release/foundryvtt-mcp-1.5.3.tgz
```

The digest binds the uploaded archive to the reviewed file; it is not itself proof
of publisher identity. The dispatcher accepts only an exact numeric version and
SHA-256 digest, checks the manifest name/version, installs with lifecycle scripts
disabled and saves the resolved transitive versions in `app/package-lock.json`.
The top-level package is pinned; a fresh install still resolves its declared dependency
ranges, so review the resulting lockfile when qualifying a release. There is no
routine sudo command. Its private npm cache is `/srv/foundry-mcp/cache`, not a shared
administrator or user cache. Installation diagnostics go to stderr.

Create a private local dotenv file with the Foundry connection credentials. Keep
secrets out of command arguments and MCP client JSON. An example shape is:

```dotenv
FOUNDRY_URL=https://YOUR_FOUNDRY_HOST
FOUNDRY_USERNAME=mcp-api
FOUNDRY_PASSWORD=YOUR_SECRET
FOUNDRY_WRITE_ENABLED=false
```

Set `FOUNDRY_ALLOW_PRIVILEGED_ACCOUNT=true` only for the privileged account or REST
configuration described in the permission matrix. The dispatcher replaces the file
atomically with mode 0600 and refuses unsafe existing paths:

```sh
chmod 600 ./foundry-remote.env
ssh -T foundry-mcp configure < ./foundry-remote.env
ssh -T foundry-mcp verify
```

`verify` returns numeric UID/GID/groups and modes, never the credentials. Expect
nonzero UID/GID, only the private group, home/config 0700 and credentials 0600.
The credentials live at `/srv/foundry-mcp/config/.env`; the dispatcher starts there
so the existing quiet dotenv loader reads them. The account owns home, app, config,
cache and lock; root owns the runtime, dispatcher, SSH policy and authorized keys.
No unrelated account should be able to read the private directories or dotenv file.

## Client process and routine operations

Configure your MCP client to execute SSH with the alias above:

```json
{
  "mcpServers": {
    "foundry-remote": {
      "command": "ssh",
      "args": ["-T", "foundry-mcp", "run"]
    }
  }
}
```

Connect, verify MCP initialization and `tools/list`, then call `roll_dice` with
`{"formula":"1d1","engine":"local"}`; expect total 1. Verify the intended Foundry
read permissions separately against your live world. The shipped lab uses a synthetic
REST service; it qualifies SSH/OS isolation and protocol transport, not a new Foundry
version or permission combination.

Stop all MCP processes of this account with `ssh -T foundry-mcp stop`. This signals
only its exact installed MCP entrypoint. Reconnect the MCP client to restart. A shared
lock held by every running MCP process prevents install, configure or remove until
clients stop; operations fail promptly instead of modifying live files. Wait for the
clients to exit before upgrading, then upload a newly reviewed pinned artifact and
reconfigure if needed. If npm installation fails, the previous installation remains.
Concurrent MCP clients share the same application credentials and permissions.

For host checks, an administrator can run:

```sh
sudo -u unrelated cat /srv/foundry-mcp/config/.env        # must fail
sudo -u foundry-mcp cat /home/unrelated/private          # must fail
sudo -u foundry-mcp cat /opt/unrelated-app/private        # must fail
sudo -u foundry-mcp touch /etc/foundry-mcp-denied         # must fail
```

Also confirm that `ssh foundry-mcp id`, a shell, SCP/SFTP, a PTY and remote forwarding
are rejected. These are supported by the automated qualification below.

## Independent revocation and removal

To revoke host access, an administrator removes the operator public key from
`/etc/ssh/foundry-mcp.keys`. New SSH authentication must fail. Existing sessions are
not revoked by that edit: stop MCP sessions first; for a compromised key, terminate
that account's remaining sessions/processes through the administrator channel. Do
not rely on the revoked key for shutdown.

To revoke application access, disable/rotate the dedicated Foundry user's password
or the REST API key at Foundry/the REST service. Existing Foundry sessions may need
explicit invalidation. Stop MCP processes and replace the dotenv file before
reconnecting. Host SSH authentication should still succeed while the old application
credential fails. Revoking one credential does not revoke the other.

For ordinary removal, close clients, then:

```sh
ssh -T foundry-mcp stop
ssh -T foundry-mcp remove
```

`remove` deletes app, cache and config, including the credential and lockfile-bearing
installation. It leaves the account home and operation lock. A future operation can
recreate empty config/cache directories. Administrators can subsequently remove the
SSH key, policy, dispatcher, runtime links and the account/home as a separate host
provisioning change. Do not remove a shared Node installation.

## Reproducible qualification

From a repository checkout with dependencies installed and a working Docker daemon:

```sh
bun run test:remote-stdio
```

The lab builds the current package, provisions a disposable Linux SSH host, installs
as the dedicated nonroot identity, verifies permissions and negative access checks,
exchanges raw MCP frames, exercises lifecycle locks and stop, tests application
credential and SSH key revocation independently, and removes app/config/cache. The
client pins the host key read directly from its own container. Container creation
requires the test operator's Docker access; the account inside gets neither Docker
access nor elevated membership. Random container/image names, private temporary keys
and loopback-only published SSH ports isolate the fixture. Cleanup removes only its
own resources. CI runs this as `Remote STDIO Isolation` without repository secrets.
