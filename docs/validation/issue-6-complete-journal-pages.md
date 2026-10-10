# Issue 6 validation receipt

Validated on 2026-10-09 UTC against the disposable local server at
`http://127.0.0.1:30001`: Foundry VTT 14.369, dnd5e 6.0.6, world `test1world`,
and foundry-rest-api 3.4.1. Foundry uses Node 24.13.1; MCP validation used
Node 26.11.0, npm 11.20.0, and Bun 1.4.2.

## Results

| Check | Result |
| --- | --- |
| Full unit suite with coverage | 1,144 passed, 41 files, zero skipped |
| Full live integration suite | 161 passed, 14 files, zero skipped |
| Focused live journal suite | 54 passed, zero skipped |
| Focused live caller-permission suite | 18 passed, zero skipped |
| Built MCP workflow suite | 82 passed, three files, zero skipped |
| TypeScript build | Passed |
| Biome check | Passed; 11 existing warnings |
| TypeDoc check | Passed; six warnings |
| Executable, dotenv, and packed-consumer smoke checks | Passed |
| Outgoing secret scan | Passed before the final test/evidence commit |
| Dependency audit | Failed: 30 advisories, including one critical, 11 high, and 18 moderate |

The final combined live run completed at 08:48:05 UTC. Its receipt reported
unchanged source inputs throughout the run. The private runner supplied local
fixture credentials and serialized tests against the real server; credentials
are absent from this document and the repository.

The dependency audit is an unresolved delivery gate, so this change is a draft
PR. The new pinned parse5 dependency has no reported advisory in that audit;
the inherited advisories have not been remediated or treated as safe. `npm audit`
cannot audit this repository's Bun lockfile and reported ENOLOCK; Bun's audit ran
and failed on the advisories above.

## Acceptance evidence

- `get_journal` version 3 returns ordered bounded page summaries with stable page
  IDs and UUIDs, typed metadata, source-format information, truncation state,
  and continuation cursors. `get_journal_page` version 1 returns complete text
  through bounded chunks. Existing journal search remains a compact preview.
- Unit and live tests cover text lengths 0, 499, 500, 501, and over 10,000
  characters, including exact reassembly across every chunk, astral Unicode,
  HTML entities, nested blocks, headings, paragraphs, line breaks, and literal
  Markdown. Live fixtures use Foundry's canonical `text.markdown` field when
  `text.format` is Markdown; they do not substitute the HTML content field.
- Empty text pages produce one empty chunk. Image and video pages return typed
  metadata with no text chunks. Null optional asset fields are normalized;
  malformed text, IDs, ownership evidence, bounds, and metadata fail closed.
  HTML parsing is inert: scripts and other active content are omitted from
  text output, and asset contents are never fetched.
- Entry/page order, pagination, invalid IDs and cursors, tool/format/limit
  mismatches, and concurrent edits, reordering, and deletion are exercised.
  Source and visible metadata changes invalidate previous cursors. Socket
  embedded-page broadcasts update the parent journal cache, with focused unit
  coverage and actual create/update/delete operations in the live world.
- Live delegated tests compare inherited and explicit entry/page ownership
  against Foundry's `testUserPermission(OBSERVER)` oracle. Hidden text, Markdown,
  asset URLs, captions, metadata, totals, and cursors are excluded before
  serialization. Denied and absent documents use the same generic error.
  Caller, world, host-session, permission revocation, and disconnect/reconnect
  cases exercise both fresh reads and cursor reuse.
- The built MCP transport workflow verifies the exact eleven delegated read
  tools and four collection resources, authenticated concurrent callers,
  discovery, schemas, resources, and positive and negative journal requests.
  The full live suite also passes existing actor, item, token, condition, combat,
  chat, presence, recovery, pagination, REST, and compendium regressions.
- Fixture cleanup removes owned documents and temporary users and restores
  edited fields. The licensed test world remains running for subsequent work.

## Supported boundary and coverage limits

Journal source text is bounded to 4 MiB per page, HTML to 100,000 nodes and depth
4,096, and snapshots to 8 MiB and 10,000 pages. Chunking uses 1,024 Unicode code
points per chunk, defaults to four chunks, permits at most eight, and keeps the
combined response within 128 KiB. Cursors bind the caller-visible snapshot and
the request contract. Continuation reads require unchanged authorization and
source state; these are read APIs, not editing or asset-download APIs.

Complete journal reads require the socket backend. The REST adapter explicitly
rejects these operations. Delegated mode retains the permission boundaries
documented for issue 4; unsupported surfaces fail closed.

Repository coverage was 75.51% statements, 72.20% branches, 75.27% functions, and
75.92% lines. The new journal-read implementation reached 99.39% statements and
lines, 97.40% branches, and 100% functions; a defensive empty-stack guard remains
uncovered. These numbers are not a claim of 100% repository coverage. Required
positive and negative scenarios are tested within the supported contract above;
this evidence covers the named runtime, system, and module versions.

## Corrected and remaining validation failures

An initial full live run passed 148 tests but failed the REST compendium suite's
setup and cleanup because the private browser controller's module-enable request
timed out. The controller subsequently reported a connected module and completed
an enable request. The unchanged full suite was rerun and all 161 tests passed.
The exact cause of that transient browser-controller failure is unproven.

The first workflow invocation encountered the sandbox's local-listener restriction
and an outdated ten-tool assertion. The assertion now expects the exact eleven
verified tools; the authorized local-network run passed all 82 tests. Coverage
instrumentation also required a longer timeout for the 100,000-node bound test;
the test still verifies that explicit boundary rather than weakening it.

No new cross-browser navigation smoke was run for this issue. Issue 4's Firefox
timeout remains a historical failed browser check; the feature evidence here is
the real Foundry integration suite and built MCP workflow, not browser navigation.
