---
id: PRD-002
title: Optional Diagnostics via REST API Module
status: accepted
created: 2026-03-03
---

# PRD-002: Optional Diagnostics via REST API Module

## Problem Statement

Troubleshooting a live FoundryVTT session requires access to server logs, health metrics, and error analysis. The core Socket.IO connection does not expose these operational signals. A companion FoundryVTT module that provides a local REST API can surface this data, but the MCP server must integrate with it optionally so that users without the module are unaffected.

## Requirements

### Functional

1. **Optional Activation** - Foundry-backed diagnostics are available only after an authenticated diagnostics operation returns the expected schema. A configured key, tool registration or public core status response is insufficient. Users without a compatible module are not impacted.

2. **MCP Tools** - The intended verified integration provides the following five tools:
   - `get_recent_logs` - Retrieve filtered FoundryVTT server logs
   - `search_logs` - Search logs with regex patterns
   - `get_system_health` - Server performance and health metrics
   - `diagnose_errors` - Analyze errors and return troubleshooting suggestions
   - `get_health_status` - Comprehensive health diagnostics

3. **MCP Resource** - Serve verified Foundry diagnostics through `foundry://system/diagnostics` only when its authenticated operation succeeds. Existing utility output does not prove diagnostics support.

4. **Module Distribution** - The companion FoundryVTT module (`module.json`) is published as a GitHub release artifact so users can install it directly from the FoundryVTT module installer.

### Non-Functional

- REST API calls use `FOUNDRY_API_KEY` for authentication; the key is never logged.
- Diagnostics endpoints time out independently of the main Socket.IO connection.

## Out of Scope

- Writing to FoundryVTT logs or modifying server configuration via the REST API.

## Implementation Status

The current capability contract reports optional Foundry diagnostics as unavailable.
Legacy log utilities and placeholder analysis do not constitute the verified
integration described above. `get_health_status` independently reports MCP
connection and world snapshot health. See [optional capabilities](../../guides/optional-capabilities.md).
