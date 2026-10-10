# Error diagnosis

`diagnose_errors` reports diagnostics unavailable because no verified diagnostic
source is implemented. It does not retrieve logs, probe a configured provider,
classify errors, infer server health or generate troubleshooting recommendations.
Missing evidence is not a clean error window.

## Input and output

Arguments are a strict object with one optional field, `category`. When supplied,
it must be a nonblank string of 1–128 UTF-16 code units. Omission selects no
category or default. Unknown but well-formed categories are accepted and return
the same unavailable capability, because category filtering is not implemented.
Wrong types, whitespace-only values, excessive lengths and unknown fields return
MCP `InvalidParams`. `timeframe`, `since` and `limit` are unsupported and rejected.

Both `{}` and `{"category":"module"}` return this versioned structured result
and identical JSON in the text content:

```json
{
  "schemaVersion": 1,
  "capability": {
    "feature": "diagnostics",
    "status": "unavailable",
    "reason": "No verified diagnostic source is implemented.",
    "remediation": "Inspect authoritative server logs or configure a verified diagnostic source."
  }
}
```

The advertised input and output JSON schemas reject additional properties.
Responses are bounded to 128 KiB, never echo the category, and contain no error
counts, system status, health score, suggestions, evidence IDs or timestamps.
`get_capabilities` uses the same unavailable reason and remediation. Its existing
`verifiedAt` is the report time, not a diagnostic observation or proof that logs
were read. Relay access failures or recovery cannot turn diagnosis into healthy.

Delegated mode hides and denies this unverified surface before parsing arguments,
even for a trusted caller. Service-identity mode exposes the unavailable contract
without requiring an optional diagnostic API key.

## Existing utilities and verification boundary

`get_health_status` continues reporting connection and world snapshot health.
Legacy `get_recent_logs`, `search_logs` and `get_system_health` retain their own
API-key, log-filter and source-metric behavior. Compatibility workflow fixtures
verify those behaviors; they do not prove access to Foundry server logs. The
unused legacy `DiagnosticsClient.diagnoseErrors` method is preserved for API
compatibility and is not connected to this tool.

Unit tests verify both routers, strict schemas, authorization and zero source
access. Built MCP workflows cover invalid parameters, hostile source states,
text/structured parity and legacy log/health preservation. Licensed integration
tests verify the unavailable contract on Foundry 14.369 / dnd5e 6.0.6 / test1world,
with and without REST relay 3.4.1, a real missing diagnostic endpoint, and controlled
relay failure/recovery.

Seeded error records, clean windows, stale/partial windows, malformed diagnostic
records and evidence references cannot be tested as observed diagnoses until a
verified provider and its coverage/provenance contract exist. These cases remain
outside the implemented capability; they are not represented as zero errors or
successful analysis. See [optional capabilities](optional-capabilities.md).
