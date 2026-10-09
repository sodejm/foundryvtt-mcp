# Dice contract

`roll_dice` uses the same bounded formula grammar for local and Foundry evaluation.
It validates the complete formula before consuming random values or sending a
remote request. This is a supported subset of Foundry's notation, rather than an
arbitrary expression evaluator.

## Input and grammar

The input is a strict object with `formula`, optional `reason` and optional
`engine`. Unknown fields are rejected. `formula` is a nonblank string of at most
100 characters; `reason`, when present, is nonblank and at most 256 characters.
`engine` is `auto` (default), `local` or `foundry`.

| Syntax | Examples | Behavior |
| --- | --- | --- |
| Whole numbers and addition/subtraction | `7`, `1d20+5`, `2d6-3` | Signed additive arithmetic |
| Dice | `d20`, `2d6`, `0d6` | Omitted count means one; zero dice consume no random values |
| Parentheses and unary signs | `(2d6+3)-(1d4-2)`, `-(1d6+2)` | Grouped additive expressions |
| Keep highest/lowest | `4d6kh3`, `2d20kl` | Keep the requested number; omitted modifier count means one |
| Drop highest/lowest | `4d6dh1`, `4d6dl` | Drop the requested number; omitted modifier count means one |
| Unsupported | `1d6*2`, `1d20r1`, `1d6x6`, `@abilities.str.mod`, `{1d6,1d8}` | Rejected before evaluation |

Only one of `kh`, `kl`, `dh` or `dl` may follow a dice term. Explicit modifier
counts must be positive and cannot exceed a positive dice count. `0d6kh` remains
an empty roll. Dice and modifier letters are case-insensitive (`D6`, `2D6KH1`).
Short aliases such as `k` and `d`, chained modifiers, rerolls,
explosions, pools, fractions, variables and JavaScript are not accepted.

The bounds apply to the entire formula: at most 1,000 dice, 50 numeric/dice terms,
10 levels of parentheses, 1,000,000 faces per die and 1,000,000,000 per integer
constant. Splitting dice across terms does not bypass the aggregate limit.

Foundry supports a wider notation and has its own modifier defaults. The MCP
subset deliberately rejects explicit zero or oversized modifier counts. See
Foundry's [dice modifier reference](https://foundryvtt.com/article/dice-modifiers/)
for the native notation and [Roll API](https://foundryvtt.com/api/classes/foundry.dice.Roll.html)
for the official engine.

## Engine selection and failure behavior

| Selection | Behavior |
| --- | --- |
| `local` | Evaluate locally even when a remote transport is configured |
| `auto`, no dice transport | Evaluate locally and report `foundry-transport-not-configured` as the fallback reason |
| `auto`, configured transport | Evaluate once through Foundry; errors remain errors |
| `foundry` | Require a configured Foundry transport; missing transport is an error |

The supported Foundry transport is the paired REST module/relay configured with
all three `FOUNDRY_REST_URL`, `FOUNDRY_REST_API_KEY` and
`FOUNDRY_REST_CLIENT_ID` values. Partial REST configuration is an error, not a
reason to evaluate locally. The adapter calls `POST /roll` with
`createChatMessage: false`. Complete paired configuration takes precedence when
a legacy `FOUNDRY_API_KEY` is also present. A legacy-only configuration fails
before HTTP: that route's total and optional numeric results cannot establish
dice counts, faces, active flags or a matching formula. Configure the paired REST
values to use Foundry, or select `engine: local` explicitly.

After a remote roll request starts, authentication failures, disconnects,
timeouts, malformed responses and other failures never cause an automatic retry
or local fallback. A timeout may mean Foundry evaluated the request but its
response was lost. A caller who explicitly requests another roll must account
for that uncertainty.

## Result

The advertised strict output schema has `schemaVersion: 1`, the actual `engine`,
`normalizedFormula`, `dice`, integer `total`, `breakdown`, ISO `timestamp`,
optional `reason` and `fallback`. JSON text and MCP `structuredContent` carry the
same value. `fallback` is null except for `auto` with no configured transport,
where it contains `requestedEngine: auto` and the reason above.

Each dice term identifies its `termIndex`, normalized `formula`, `count`,
`faces`, nullable `modifier` and all `results`. Every result has its numeric
`result` and `active` flag; dropped dice remain visible with `active: false`.
Native responses are checked for matching dice counts/faces, valid result
ranges, modifier selection and a total consistent with the additive expression.

This contract changes the older text-only roll response into a versioned
structured result. Clients should consume `structuredContent`, inspect `engine`
and `fallback`, and validate against the schema advertised by `tools/list`.
`roll_dice` remains unavailable in delegated mode.

## Verification

The workflow suite drives the built MCP server through local, paired REST,
partial configuration and legacy-only paths. It checks schema agreement, rejected input before
HTTP, one remote attempt on failure and absence of silent fallback. The live
suite uses the disposable `test1world` on Foundry 14 and compares the local
evaluator with official `Roll.evaluate()` under identical controlled random
values, including tied keep/drop results, zero dice and aggregate limits.

`scripts/dice-test-control.mjs` is a loopback-only test oracle. It requires a GM
session in the disposable `test1world` using `dnd5e`, restores Foundry's random
source after each request and creates no chat message. It is test infrastructure,
not a production dice endpoint.
