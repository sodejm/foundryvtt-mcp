# Item economy fixture provenance

The item economy adapter is based on the following exact upstream system versions:

- D&D 5e `6.0.6`, commit [`87e94dbd9f930135e0694cd7e7d49f210603cd2c`](https://github.com/foundryvtt/dnd5e/tree/87e94dbd9f930135e0694cd7e7d49f210603cd2c), distributed under the [MIT license](https://github.com/foundryvtt/dnd5e/blob/87e94dbd9f930135e0694cd7e7d49f210603cd2c/LICENSE.txt).
- Pathfinder 2e `7.8.0`, commit [`1465f7190b2b8454094c50fa6d06e9902e0a3c41`](https://github.com/foundryvtt/pf2e/tree/1465f7190b2b8454094c50fa6d06e9902e0a3c41), distributed under the [Apache License 2.0](https://github.com/foundryvtt/pf2e/blob/1465f7190b2b8454094c50fa6d06e9902e0a3c41/LICENSE).

The fixture documents in `tests/fixtures/item-economy` are small, synthetic examples authored for this repository. They contain no copied game content. They are covered by this repository's MIT license.

The adapter reads only the documented economy candidates: `price`, `rarity`, `rarities`, and `traits.rarity`. The fixtures deliberately include unrelated fields to verify that the safe source projection removes them.

## Supported systems

Adapters match the exact system ID and version below. A different or missing version reports `unsupported-version`; other system IDs report `unsupported-system`. Neither fallback infers a currency or rarity.

| Adapter | Price source and units | Rarity source | Applicable item types |
| --- | --- | --- | --- |
| `dnd5e@6.0.6` | `system.price.value` plus `denomination` (`cp`, `sp`, `ep`, `gp`, `pp`); preserves zero and fractional values | `system.rarities`, including multiple canonical values | consumable, container, equipment, loot, tool, weapon |
| `pf2e@7.8.0` | `system.price.value` coin object (`cp`, `sp`, `gp`, `pp`) plus optional positive integer `per`; preserves each denomination separately | `system.traits.rarity` | Price: ammo, armor, backpack, book, consumable, equipment, shield, treasure, weapon. Rarity: these types, feat, spell, and other types that expose `traits.rarity`. |

The normalized `economy` object uses schema version `1`. It separates adapter identity/capability, bounded source fields, price status/currencies/quantity basis, and rarity status/values. Price and rarity statuses are `known`, `missing`, `invalid`, `not-applicable`, or `unsupported`. An unsafe or unavailable source reports adapter status `source-unavailable` and invalid values. Missing physical-item fields stay missing; fields outside an adapter's applicable types are not applicable. A known empty D&D rarity array remains empty.

Canonical D&D rarities are `artifact`, `common`, `legendary`, `mundane`, `rare`, `uncommon`, `varies`, and `veryRare`. PF2e rarities are `common`, `uncommon`, `rare`, and `unique`. Source labels are preserved without translation. Localized labels and numeric price shorthand are invalid for these pinned adapters.

The source projection is capped at 4 KiB, with strings up to 256 characters and arrays up to 16 scalar entries. It drops unrelated fields and rejects accessors, unsafe object keys, cycles, and oversized candidates. It preserves supported raw candidates for unknown systems without normalizing them.

## Public tools and filters

`search_items` returns schema version `4`, `get_item_details` version `3`, and actor-owned item list/detail tools version `2`. They use the same economy adapter. World UUIDs and actor-parent UUIDs remain distinct. Existing top-level world-item `price` and `rarity` aliases appear only when the normalized value has an unambiguous single currency/rarity; a quantity basis greater than one also prevents a price alias.

Name queries and item type filters are case-insensitive. Rarity filters use canonical values, compare case-insensitively, and run before pagination, so totals and cursors describe the filtered set. Empty rarity filters have no effect. Unsupported system/version filters, unsupported labels, and invalid/unavailable matching rarity sources return MCP `InvalidParams`. Missing and not-applicable rarities do not match a rarity filter.

For example, a D&D zero-priced loot item with `price: {value: 0, denomination: "gp"}` and `rarities: []` yields known price `0 gp` and known empty rarity. A PF2e equipment item with `price: {value: {sp: 2, gp: 3}, per: 2}` and `traits: {rarity: "unique"}` yields separate `2 sp` and `3 gp` entries per two items. No cross-system conversion is performed.

## Validation boundaries

Synthetic fixtures exercise both adapters through normalization, client, handler, and built stdio CLI tests, including Socket.IO/REST agreement. REST economy normalization requires raw `system` fields and system identity from `/api/world`; an identity endpoint returning 404 leaves economy unsupported. Other identity failures propagate. The real Foundry REST API module `3.4.1` does not provide these item/world endpoints, so those REST paths are verified against HTTP fixtures.

The live item suite seeds and removes its own prefixed world and actor-owned documents in disposable `test1world`, running Foundry core `14.369` with D&D `6.0.6`. It compares normalized output with seeded source fields, checks exact pagination/filter totals, and observes edits and deletion. PF2e support is fixture-verified; a live PF2e world was not tested.
