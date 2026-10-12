# Foundry service account permissions

Use a dedicated Player account for scoped reads and local dice. Grant OBSERVER
(2) on the actors, world items and journals it may read, and OWNER (3) only on
actors it may change. A separate account alone does not restrict the documents
Foundry sends over Socket.IO: the MCP public read methods apply an ownership
projection before returning results, counts or pagination cursors.

`FOUNDRY_ALLOW_PRIVILEGED_ACCOUNT` and `FOUNDRY_WRITE_ENABLED` both default to
`false`. Setting either flag does not grant Foundry permissions. Assistant (3)
and Gamemaster (4) connections require the privileged flag; Player (1) and
Trusted Player (2) remain filtered even when that flag is enabled. The server
checks the authenticated world user and role on connection, refresh and access.
Invalid roles, duplicate or missing users and mismatched socket identities fail
with a reconnect/refresh error. It never retries as another user or promotes one.

## Capability matrix

These are minimum grants for the native transport. Individual world permissions,
system rules and module hooks may deny an operation even when these grants exist;
Foundry performs the final authorization for every mutation.

| Capability | Minimum account/grant | Behavior and limits |
| --- | --- | --- |
| Actor searches, profiles, sections and inventory | Player; actor OBSERVER | Hidden actors are omitted; embedded ownership and unidentified item restrictions apply; secret HTML is removed. Unknown-system generic sections are unavailable to lower roles. |
| World item searches/details and economy reads | Player; item OBSERVER | Hidden and unidentified items are omitted; secret descriptions are removed. |
| Journal searches, metadata and complete pages | Player; journal/page OBSERVER | Page ownership can inherit from the journal or explicitly restrict access; hidden pages and secrets are removed. |
| Search/world summary and actor/item/journal/user pagination | Player; OBSERVER on returned documents | Filtered counts/cursors; only the authenticated user's safe profile is returned. No raw scene/settings/module collections. |
| Chat messages | Player; message visibility | Public and caller-visible whispers; other users' whispers and blind rolls are omitted; secret markup is removed. |
| Structured scene/token spatial reads | Player; scene OBSERVER and required token actor visibility | Uses the existing scoped spatial contract; hidden tokens and unauthorized linked actors are omitted. |
| Capabilities, connection health and error diagnosis | Player; no additional ownership | Returns bounded diagnostic metadata; does not grant document reads. |
| Local/auto dice | No Foundry document grant | Evaluates locally; no world write or GM role needed. Delegated mode disallows dice. |
| Explicit Foundry dice, compendium/rule retrieval and REST document reads | Privileged opt-in; paired relay credentials and route scopes where required | Relay keys do not prove the executing user's Foundry role or ownership. Unsupported or insufficient-scope routes fail. |
| Raw scene/token reads, scene collection pagination, combat, settings and legacy rules | Assistant/GM plus privileged opt-in | Lower-role public methods reject these surfaces. Full-world access is appropriate only for trusted campaign administration. |
| Actor attributes, embedded item creation/update/delete and actor effects | Player; actor OWNER; writes enabled | Tested allowed on owned actors and denied on shared actors. Token effect handlers also need privileged token lookup. |
| Journal creation | Trusted Player with CREATE_JOURNAL; writes enabled | Default Player is denied. Custom world permissions can change this minimum. |
| Token movement/visibility/effects and combat creation/update/delete | Assistant/GM; privileged opt-in and writes enabled | Current public tool paths require privileged scene/token/combat reads in addition to server-side operation permissions. |

A read-only Player setup needs only the URL, user credentials and selected
OBSERVER grants. Leave both flags false. For owned actor mutations, enable only
writes and grant OWNER on those actors. Use Trusted Player only when journal
creation is needed and permitted by the world's CREATE_JOURNAL setting.

For full-world GM workflows or optional REST integration, explicitly set
`FOUNDRY_ALLOW_PRIVILEGED_ACCOUNT=true`. Keep this account in a separate MCP
process and credential configuration from the Player read process. Enable writes
only on the process that needs mutations. GM integration intentionally exposes
full-world information; do not expose that process to untrusted callers. For
multi-user hosts use the separate trusted caller resolver and delegated boundary
from [configuration](configuration.md); privileged opt-in does not replace it.

## Verification and version scope

`tests/integration/service-permissions.integration.test.ts` creates temporary
Player, Trusted Player and Assistant users and owned/shared/hidden documents. It
checks filtered actor/item/journal/user reads, secret removal, denied raw reads,
local dice, allowed owned actor/item/effect writes, denied shared/hidden writes,
Player journal denial, Trusted Player journal creation and Assistant/GM opt-in.
Fixtures are deleted after the run. The native run passed all three cases against
Foundry **14.369**, dnd5e **6.0.6**, disposable `test1world` with default world
permissions. Existing structured-read, spatial, dice, diagnostics and mutation
suites cover their respective contracts; unit/workflow tests exercise disabled
writes, REST rejection before HTTP, invalid identities and privileged opt-in.

Foundry 13's historical mutation wire-format check is not a live lower-role
qualification. This matrix is live-qualified only for the version/system above;
rerun the suite on each additional supported deployment before relying on its
role defaults. Module, system or world permission changes require revalidation.

Run with private world login configuration and a GM fixture account (the suite
creates its own lower-role users):

```sh
bun run test:integration tests/integration/service-permissions.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

The fixture client's privileged opt-in is confined to integration setup. It does
not change the production default. Keep world/download credentials out of logs
and source control; see the [integration guide](integration.md).
