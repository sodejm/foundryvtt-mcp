# NPC and loot creative previews

`generate_npc` and `generate_loot` return structured, world-independent creative
previews. They use local narrative templates and random choices. They do not
consult a game system, create Foundry documents, or supply verified rules or
prices. They are available without optional REST configuration in the ordinary
GM mode and are hidden and denied in delegated mode.

Both tools publish strict input and output schemas. Every result has
`schemaVersion: 1`, a JSON text block matching `structuredContent`, and this
preview metadata:

```json
{
  "mode": "creative-preview",
  "status": "preview",
  "persisted": false,
  "rulesVerified": false,
  "system": null,
  "systemVersion": null
}
```

The metadata also lists `supportedOptions` and explicit `limitations`.
`defaultsApplied` identifies omitted options. Results contain no document IDs,
UUIDs, stat blocks, or implied world mutation and are bounded to 128 KiB.
`get_capabilities` reports verified `contentGeneration` as unavailable while
explaining that these local creative previews remain available.

## NPC inputs

| Option | Accepted values | Default | Effect |
|--------|-----------------|---------|--------|
| `level` | Integer from 1 to 20 | `1` | Returned level and narrative scale |
| `race` | Nonblank string, at most 64 UTF-16 code units | `Riverfolk` | Exact returned label and background text |
| `class` | Nonblank string, at most 64 UTF-16 code units | `Wayfinder` | Exact returned label and background text |

For example, call `generate_npc` with
`{"level":7,"race":"Clockwork","class":"Archivist"}`. The `npc` object includes
those exact values, a random name, personality, appearance, motivation and
background. `narrativeScale` is `local` for levels 1–4, `notable` for 5–10,
`formidable` for 11–16, and `legendary` for 17–20. These are narrative categories;
level does not establish game statistics or encounter balance.

## Loot inputs and valuation

| Option | Accepted values | Default | Effect |
|--------|-----------------|---------|--------|
| `challengeRating` | Finite number from 0 to 30, including fractions | `1` | Creative currency scale |
| `treasureType` | `individual` or `hoard` | `individual` | Currency multiplier and number of item ideas |

For example, call `generate_loot` with
`{"challengeRating":7,"treasureType":"hoard"}`. The `loot` object returns those
inputs, two fictional currency denominations and three item ideas. An individual
preview returns one item idea. Item ideas have no verified mechanics or prices.

Let `s = challengeRating + 1` and `m = 4` for a hoard or `1` for an individual.
With separate random draws `r` in `[0, 1)`, currency amounts are:

```text
glints = floor(s * m * (4 + r * 5))
crowns = floor(s * m * (1 + r * 2))
knownCurrencySubtotal = glints + crowns * 10
```

The explicit fictional conversion is one crown to ten glints. Each denomination
includes its amount and base-unit value, and `knownCurrencySubtotal` states the
arithmetic basis. Every item has `valuation.status: "unknown"` and a reason.
`overallValue.status` remains `unknown` because item prices are unknown; its
currency subtotal is not a total treasure valuation. The formula is a creative
scaling convention, not a licensed treasure table or system economy.

## Validation and compatibility

Unknown fields, wrong types, blank labels and out-of-range values fail with MCP
`InvalidParams`. In particular, `system`, `persist`, and document IDs are not
supported inputs. A connected D&D world does not select a D&D generation mode.
Delegated authorization is checked before argument validation.

This changes the former template text response to a versioned JSON contract.
Consumers should read `structuredContent`, inspect `preview`, and use the `npc`
or `loot` object rather than parsing the former prose or expecting game-specific
currency fields. Repeated calls may vary. Unit tests use an injected random
source to verify reproducibility, variation, scaling and arithmetic.

Creating a new NPC actor requires the Foundry UI or another supported integration.
The separate `create_actor_item` MCP tool can add a reviewed item to an existing
actor when supplied valid actor and system item data. Creative preview output is
not a document creation payload, and generation does not call mutation tools or
infer a system document schema. See the
[issue 11 validation](../validation/issue-11-truthful-generation.md) for the
tested contracts and live world preservation checks.
