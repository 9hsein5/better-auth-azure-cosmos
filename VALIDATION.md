# Validation Report: 0.5.1

Date: 2026-09-10.

Release version: `0.5.1`. The version-only bump follows the validated fixes below;
historical package artifacts named `0.5.0` were generated before that bump.

Reviewed merge: `8595b03`, including implementation commit `d8cbdd8`.
Comparison baseline: first parent `fee9e7f` (adapter 0.4.3).

## Extended Release Validation

This is the final result of the deeper WSL release pass on 2026-09-10. It
supersedes the earlier checkpoints below. All executed release gates pass; this
is evidence for the tested scenarios, not a guarantee that the release has no bugs.

This pass identified and fixed three additional edge cases:

- A null equality predicate now matches omitted nullable fields as well as
  explicit JSON null. Null inequality is its complement. Live regressions cover
  guarded increments, reads, and counts for missing, null, zero, and nonzero values.
- Azure limits a document patch to ten operations. Wider increments now use a
  single ETag-protected replacement with the same retry and partition checks.
  Boundary tests assert both the SDK request shape and the final database values
  for ten and eleven fields, with one and eight concurrent callers.
- Package exports now select the ESM declaration file for `import` and the
  CommonJS declaration file for `require`. Strict publint initially detected the
  shared ESM declaration condition; both publint and consumer-type resolution
  checks pass after splitting the conditions.

The emulator accepted an eleven-operation patch, unlike the documented Azure
limit. The SDK-boundary assertion is intentional: an emulator-only result cannot
establish parity for that limit. A newly started emulator also accepted connections
while data requests returned 503 because the database engine was still starting.
This pass used its `http://localhost:8080/ready` health probe to distinguish
readiness from code errors.

An HTTP-level test now exercises Better Auth's own database rate limiter. Each
twelve-request burst admits three requests and returns nine 429 responses, both
on the first window and after expiring the stored window. It checks retry headers
and verifies that another client receives an independent budget.

The expanded suite contains 544 cases, all executed against the local HTTPS
Cosmos emulator with Better Auth/core/test utilities 1.7.4 and Cosmos SDK 4.10.0.

| Native Linux Runtime | Full Suite | Typecheck | Build | Test Duration |
| --- | --- | --- | --- | --- |
| Node 20.20.2 | 544 passed, 0 failed, 0 skipped | Passed | Passed | 91.11 seconds |
| Node 22.23.2 | 544 passed, 0 failed, 0 skipped | Passed | Passed | 110.54 seconds |
| Node 24.19.0 | 544 passed, 0 failed, 0 skipped | Passed | Passed | 90.98 seconds |

The six focused routing, mutation, uniqueness, startup, and HTTP-limiter files
also ran ten times with shuffled ordering and seeds 1 through 10. Each run passed
all 72 tests. That is 720 additional passing test executions, with zero failures
or skips, on top of the 1,632 full-matrix executions. The combined total is 2,352;
this counts repeated executions, not 2,352 distinct scenarios.

| Better Auth Version | Additional Compatibility Result |
| --- | --- |
| 1.6.0 | Startup guard and 7 live account-routing tests passed. |
| 1.7.0 | Startup test passed: accountKey refused; default layout still constructs. |
| 1.7.1 | Startup test passed: accountKey refused; default layout still constructs. |
| 1.7.2 | Startup test passed: accountKey refused; default layout still constructs. |
| 1.7.3 | Startup guard and 7 live account-routing tests passed. |
| 1.7.4 | Full suites and repeated tests in the matrix above. |

Each compatibility install aligned `@better-auth/core` and the test utilities to
the Better Auth version. These 19 targeted compatibility executions are not a
claim that the entire 544-case suite ran on every older version.

Package and security gates also passed:

- `publint --strict`: no package metadata or declaration-format warnings.
- Are the Types Wrong: no problems in its reported Node-style and bundler
  resolution profiles. These are TypeScript resolution profiles, not a claim of
  support for the older Node runtimes named by those profiles.
- The actual tarball installed into a fresh consumer and loaded through both
  `require` and `import` on Node 20, 22, and 24, with the same ten runtime exports.
- The tarball contains seven intended files, no tests, no review probes, and no
  bundled dependencies; compressed size is 28,367 bytes.
- Both the complete locked development graph and the clean consumer's actual
  runtime dependency graph returned zero npm audit vulnerabilities.
- Byte comparisons confirmed that the workspace source, tests, package metadata,
  and lockfile match the validated Linux copy.

Artifacts remain in these isolated Linux directories:

```text
/home/husseinahmad/better-auth-cosmos-verify-pwwcg8M2
/home/husseinahmad/better-auth-cosmos-release-compat-2ZiUD9Tr
/home/husseinahmad/better-auth-cosmos-release-consumer-Ll3sVzSJ
```

The main copy contains `release-node20.json`, `release-node22.json`,
`release-node24.json`, and `release-stress-1.json` through
`release-stress-10.json`. The compatibility copy contains the version-specific
reports and ends with Better Auth 1.7.3. The consumer copy contains the tested
tarball, with SHA-1 `4bc853018e553dabb5233510f54ef577f9844557`. Nothing was published
or committed. The task-owned release-validation emulator is stopped afterward.

Remaining release conditions: rehearse the 0.4.x account-key migration on a
backup/restored database, and run a staging smoke against a real Azure Cosmos DB
account with the application's actual providers and plugins. Production RU costs,
429 throttling, multi-region behavior, large datasets, and all possible provider
configurations are not certified by these local tests. Node 20/22/24 are tested
at the exact patch versions above, not every patch release. The Windows editor's
missing-module state remains separate from the clean WSL typechecks.

Reference: [Cosmos partial-document update limits](https://learn.microsoft.com/en-us/azure/cosmos-db/partial-document-update).

## Initial Post-Fix Validation

The current working-tree fixes were verified on 2026-09-10 in a fresh native
Linux directory under WSL2 Ubuntu 24.04. This section supersedes the original
review results below, which are retained as historical evidence.

All four runtime/configuration findings are addressed:

- Guarded increments use ETag-protected snapshots and bounded retries regardless
  of whether `set` is supplied. Each retry re-evaluates the complete predicate.
  Pure ID-selected numeric increments still compose without an ETag, and
  concurrent first increments from absent or null counters now compose too.
- `incrementOne` validates partition immutability before writing, as do ordinary
  and bulk updates. Regression tests cover account, session, and rate-limit keys.
- Hash strategies reject renamed models and hashed fields at construction instead
  of silently losing protection. Custom physical container names remain supported
  through `layout.containerName`, with live routing and uniqueness coverage.
- `accountKey` rejects a required issuer schema, including Better Auth 1.7.0,
  before any database operation. It does not attempt to provide issuer-based
  identity enforcement. Default ID layouts remain available.

Vitest and its affected transitive dependencies were updated. The full npm audit,
including development dependencies, reports zero vulnerabilities.

| Check | Post-Fix Result |
| --- | --- |
| Fresh WSL `npm ci` from the current lockfile | Passed. |
| Full source/test typecheck | Passed. |
| ESM, CommonJS, and declaration build | Passed. |
| Full suite on Better Auth 1.7.4 | 533 passed, 0 failed, 0 skipped across 8 files; 85.67 seconds. |
| Better Auth 1.7.0 startup compatibility | Passed: accountKey refused; default layout still constructs. |
| Better Auth 1.6.0 compatibility | Startup check and all 7 account-routing tests passed. |
| Both built package entrypoints | Passed; matching 10 runtime exports. |
| Full dependency audit | 0 vulnerabilities. |

Runtime: Node 24.19.0, Cosmos SDK 4.10.0, Better Auth/test utilities 1.7.4,
TypeScript 5.9.3, and Vitest 4.1.11. The full suite includes 18 additional cases
relative to the original 515-test baseline. No production Azure data was used;
database tests ran against the local HTTPS Cosmos DB emulator with cloud
connection overrides removed.

The verified source and dependencies remain at:

```text
/home/husseinahmad/better-auth-cosmos-verify-pwwcg8M2
```

Machine-readable results are in `wsl-test-results.json` inside that directory.
Unlike the older review copy, this directory contains no historical negative
probes. With a local emulator running and native Node on PATH, rerun:

```bash
npm run verify
```

The separate fixed compatibility copy is at
`/home/husseinahmad/better-auth-cosmos-fixed-compat-8mIUXI5i` and ends with aligned
Better Auth/core/test utilities 1.6.0. The 1.7.0 startup check was executed before
switching that copy to 1.6.0. Neither check changed the primary validation copy.

The README now documents the corrected guard, seeding, naming, and version
requirements. The source and regression-test fixes are retained in the Windows
workspace. Its earlier interrupted dependency install still causes missing-module
editor diagnostics; Windows installation was not retried after the request to
test in WSL. The Linux typecheck is clean. Node 20/22 and production Azure behavior
were not independently tested. The fix-session emulator is stopped after testing.

## Original Verdict (Before Fixes)

The intended Better Auth 1.7.4 configuration works in the tested local environment:
all 515 committed tests pass against the Cosmos DB emulator, and typechecking,
building, and both package entrypoints pass.

This is not an unqualified approval of every advertised configuration. Review
probes reproduced three API/configuration defects, and a before/after comparison
confirmed an account-identity enforcement regression on Better Auth 1.7.0. The
three API defects are in code paths that predate this merge; the issuer-era
compatibility regression comes from the new identity strategy. No production
fixes were applied during this review.

## Original Findings (Before Fixes)

### 1. High: Account identity enforcement regresses on Better Auth 1.7.0

Locations: [src/layout.ts](src/layout.ts#L219),
[src/adapter.ts](src/adapter.ts#L354), and
[package.json](package.json#L50).

The peer range accepts Better Auth 1.7.0, and adapter construction accepts
`accountPartition: "accountKey"` with that version. However, 1.7.0 resolves identity
by `(issuer, accountId)`, while the new layout partitions and enforces uniqueness
by `(providerId, accountId)`.

Reproduction used Better Auth 1.7.0, its matching core and test utilities, and its
own `should enforce the issuer-scoped account identity key` test. Two accounts
with the same issuer and subject, but different provider aliases and users, were
accepted when the second create should have failed.

| Source Version | Identical Upstream Identity Tests |
| --- | --- |
| Previous commit `fee9e7f` | 2 passed |
| Latest commit `8595b03` | 2 failed |

The comparison changed only the adapter source, keeping the aligned 1.7.0
dependencies and test harness fixed. Both the normal and joins variants failed
on the latest source.

The [README](README.md#L151) acknowledges the lost issuer constraint, so this is
not an undocumented behavior change. It is still a correctness limitation for
an accepted authentication configuration, not merely a slower query path.

Recommendation: reject the issuer-era versions for this strategy at startup, or
provide a separately validated issuer strategy. Do not claim the new account-key
strategy preserves the old identity guarantee. The failure was executed on
1.7.0; 1.7.1 and 1.7.2 were not individually tested.

### 2. High: A conditional increment can exceed its bound without `set`

Location: [src/adapter.ts](src/adapter.ts#L569).

`incrementOne` adds an ETag precondition only when `set` has fields. The optional
presence of `set` does not determine whether `where` contains a guard. A caller
can validly request an increment only while `attempts < 3`, without changing any
other field.

Reproduction extended the existing concurrency test to run both with and
without `set`. Eight concurrent calls started from an existing numeric zero:

| Mutation | Guard | Observed Result |
| --- | --- | --- |
| Increment plus `set` | `attempts < 3` | Stayed at or below 3 |
| Increment without `set` | `attempts < 3` | Reached 8 |

This violates the native increment contract: the predicate must still match when
the mutation is applied. It can affect guarded counters used by applications or
plugins. The passing built-in auth-flow tests do not establish that every such
consumer is safe.

Recommendation: preserve the predicate at mutation time independently of `set`,
using a server-side patch condition or a suitable conditional-write/retry
strategy. Preserve composition for genuinely unguarded counters.

### 3. High: `incrementOne` can invalidate an account's partition identity

Locations: [src/adapter.ts](src/adapter.ts#L553) and
[src/adapter.ts](src/adapter.ts#L593).

Ordinary `update` merges the new fields, recomputes the hash, and rejects a
partition change. `incrementOne` patches its `set` fields directly, without
re-stamping or checking the partition invariant.

Reproduction created an account, then invoked `incrementOne` with an empty
increment object and `set: { accountId: newAccountId }`. Better Auth permits a
set-only mutation. The operation succeeded instead of rejecting the identity
change. A follow-up emulator test established both consequences:

- Looking up the changed `(providerId, accountId)` returned zero rows.
- Creating another account with that same changed pair succeeded.

The original account remained under its old hash, so the partition-scoped unique
key could no longer see both rows. This was an adapter-API reproduction, not a
demonstration of a remotely exploitable default auth endpoint.

Recommendation: apply the same immutable-partition validation to every mutation
path, including `incrementOne.set`. The analogous session and rate-limit paths
deserve coverage when implementing that fix; those variants were not reproduced
in this review.

### 4. Medium: Renaming the account model silently disables its hash strategy

Locations: [src/layout.ts](src/layout.ts#L230),
[src/layout.ts](src/layout.ts#L311), and [README.md](README.md#L83).

Better Auth supplies adapter methods with the configured physical model name.
The layout recognizes hashed accounts only when that name is exactly `account`.
With `account.modelName: "externalAccount"`, construction succeeds, but the
strategy no longer recognizes writes as accounts.

A focused test used the real Better Auth 1.7.4 adapter factory and a mocked Cosmos
container boundary. It confirmed that the write targeted `externalAccount` but
contained no `accountKeyHash`. Inspection of `requiredContainers` shows the same
literal-name check will provision the renamed model on `/id`, without the
account identity unique-key policy. Thus the advertised strategy can silently
lose its protection, or fail against a manually provisioned hash container.

Recommendation: distinguish logical model identity from physical container names
throughout layout resolution and bootstrap, or reject unsupported model renames
at construction. The existing field-rename guard does not catch this case. This
finding's execution evidence is at the mocked SDK boundary, not a live duplicate
insertion into a renamed container.

### 5. Tooling: The locked development graph has security advisories

Locations: [package-lock.json](package-lock.json#L1816) and
[package-lock.json](package-lock.json#L973).

The full public-registry npm audit reported three affected package entries:

| Package | Locked Version | Audit Severity | Fixed Range |
| --- | --- | --- | --- |
| `nanoid` | 3.3.17 | High | >=3.3.18 |
| `vitest` | 4.1.10 | Moderate | >=4.1.11 |
| `@vitest/mocker` | 4.1.10 | Moderate | >=4.1.11 |

These represent two advisories, with the Vitest advisory counted on both the
direct and transitive package. `npm explain nanoid` traced that package through
Vitest -> Vite -> PostCSS. These are development-tool dependencies, not bundled
adapter runtime dependencies. Audit severity is not proof of exploitability in
this library's production runtime.

References:

- [Nano ID advisory](https://github.com/advisories/GHSA-2v37-7h3g-55p8).
- [Vitest advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).

Recommendation: refresh the development lockfile to patched versions and rerun
verification. No dependency versions were changed in the Windows workspace.

## What Changed

The merge changes ten files:

| Files | Change |
| --- | --- |
| [package.json](package.json), [package-lock.json](package-lock.json) | Adapter 0.4.3 -> 0.5.0; Better Auth and test utilities 1.7.0 -> 1.7.4. |
| [src/partition.ts](src/partition.ts) | Account hashing now uses `providerId` instead of `issuer`; adds derivation that prefers current identity fields over a stored hash. |
| [src/layout.ts](src/layout.ts) | Routes the complete provider/account pair; stamps its hash; provisions the corresponding unique-key paths. |
| [src/adapter.ts](src/adapter.ts) | Replaces the issuer-schema requirement with a guard against renaming the stored identity fields. |
| [test/account-partition-routing.test.ts](test/account-partition-routing.test.ts) | Adds six live tests for hashing, duplicate rejection, scoped routing, user listing, and updates. |
| [test/container-partition-key.test.ts](test/container-partition-key.test.ts) | Updates the expected unique key and tests rejection of the old issuer-based policy. |
| [test/unique-warning.test.ts](test/unique-warning.test.ts) | Tests explicit plugin-declared account uniqueness and field-name validation against the new core schema. |
| [test/adapter.test.ts](test/adapter.test.ts) | Removes old exclusions for an issuer-specific upstream test that is absent in the new utilities. |
| [README.md](README.md) | Documents the new key, version caveats, field mapping restrictions, and breaking migration requirements. |

The default `/id` account strategy and single-container layout were not changed
by this merge. Session routing, rate-limit routing, `incrementOne`, query
execution, and bootstrap validation itself are pre-existing implementations.

Two source comments still describe the provider/account pair as declared unique
by Better Auth's core schema, although the updated README and warning tests
correctly state that 1.7.4 does not declare it. This is a documentation
inconsistency, not an additional reproduced runtime failure:
[src/partition.ts](src/partition.ts#L70) and
[src/layout.ts](src/layout.ts#L77).

## Verification Performed

Main environment: Ubuntu 24.04 on WSL2, native Node 24.19.0, Cosmos SDK 4.10.0,
Better Auth/core/test utilities 1.7.4, TypeScript 5.9.3, Vitest 4.1.10, and Docker
29.1.3. Dependencies were installed from the committed lockfile into an isolated
Linux filesystem copy.

The local database used the repository's `vnext-preview` emulator image at digest
`sha256:2db1f9e74c506bcf6fc347aa937aea1c00fa756061296a5a9efba530ce86ec02`.
Cloud endpoint/key/database overrides were removed from the test process. Only
local emulator databases were created and deleted.

| Check | Result |
| --- | --- |
| Clean Linux `npm ci` | Passed; exact pinned Better Auth packages installed. |
| Typecheck of source and tests | Passed. |
| ESM, CommonJS, and declaration build | Passed. |
| Full committed suite on Better Auth 1.7.4 | 515 passed across 8 files in 88.51 seconds. |
| Account-key smoke on Better Auth 1.6.0 | All 6 account-routing tests passed. |
| Issuer identity on Better Auth 1.7.0 | Latest source: 2 failed; previous source: 2 passed. |
| Custom-model factory probe | Failed as described in finding 4; all 7 original warning tests passed. |
| Extra live increment/identity probes | Both failed; the 12 original tests in those files passed. |
| Stronger identity-corruption follow-up | Confirmed zero lookup results and successful duplicate creation. |
| Original tests after restoring temporary edits | All 12 passed again. |
| Built ESM and CommonJS runtime imports | Passed, with the same 10 exported names. |
| Package dry run | 7 intended files, 26,972 compressed bytes; no tests or probes included. |
| Source/test editor diagnostics | No errors. |
| Full dependency audit | 1 high and 2 moderate package entries, confined to development tooling. |

The full committed suite includes the upstream normal, authentication-flow,
case-insensitive, and joins suites under both tested layouts, plus account and
session routing, container policy validation, rate-limit uniqueness,
increment concurrency, and warning tests.

The Windows installation was stale: both Better Auth and its test utilities were
still 1.7.0 despite the manifest requiring 1.7.4. Its initial run also had no
emulator listening. Those failures were not used to judge the current pinned
release. Windows dependencies and build output were left unchanged.

## Upgrade Requirements

An existing 0.4.x account-key container is not compatible with 0.5.0. Its stored
hashes and issuer unique-key policy differ from the new strategy. The emulator
tests verified that `ensureAuthContainers` rejects the old policy.

Before serving upgraded traffic:

1. Back up the database and rehearse migration on a restored copy.
2. Pause authentication and background writes during cutover.
3. Export accounts and recreate the account container with the new policy.
4. Remove legacy issuer/hash fields and re-import through the adapter, preserving
   IDs, or explicitly derive the new hash before a direct SDK import.
5. Run `ensureAuthContainers` before traffic and verify returning users, every
   configured provider, account linking, and token refresh.

The adapter does not validate containers automatically at runtime. Merely
updating the npm package, or copying old hashes into the new container, does not
perform this migration. Both partition-key configuration and unique-key policies
are immutable. This breaking migration is intentional and documented, distinct
from the findings above.

## Reproduction Artifacts

The main isolated Linux copy remains at:

```text
/home/husseinahmad/better-auth-cosmos-review-qrjZjtoS
```

Its original tests are restored. The two live negative probes are retained in
`review-probes/`, outside the committed workspace. With the local emulator
running and native Node on PATH, run these from that Linux directory:

```bash
npm test -- --exclude 'review-probes/**' --reporter=dot --silent
npm test -- review-probes/increment-one.test.ts --testNamePattern 'set=false'
npm test -- review-probes/account-partition-routing.test.ts --testNamePattern 'does not lose identity'
```

The last two commands intentionally fail on the reviewed source. Running the
isolated copy's unfiltered default test command also discovers these negative
probes, so use the exclusion for the committed baseline.

The separate compatibility copy is at:

```text
/home/husseinahmad/better-auth-cosmos-compat-zPzhbAiK
```

It ends with the latest source and aligned Better Auth/core/test utilities 1.6.0
for the minimum-peer smoke. The 1.7.0 before/after comparison was performed before
that dependency change; do not assume it is still installed there.

Docker Compose was absent in WSL, so the equivalent image was run directly. A
persistent attached WSL terminal was needed to keep the native Docker service
alive between commands. The initial shutdowns were not treated as an adapter or
CI defect. The review-only emulator containers were stopped and removed after
testing; the downloaded image remains cached for reuse.

## Coverage Limits

- No production Azure account was exercised, so this does not certify production
  RU costs, throttling, regional behavior, large datasets, or service/emulator
  parity.
- Node 24 was executed. The CI Node 22 environment and advertised Node 20 minimum
  were not independently exercised.
- Better Auth 1.6.0 received the six-test account smoke, not the entire upstream
  suite. Versions 1.7.1, 1.7.2, and 1.7.3 were not separately installed.
- A production upgrade with real users, all external providers, and SSO account
  sharing was not performed. The migration gate and ordinary auth flows were
  tested locally.
- No source, original test, dependency, or CI fixes were retained. This report is
  the only workspace addition; follow-up fixes should include permanent
  regression coverage for the reproduced cases.

Contract references:
[Better Auth adapter guide](https://better-auth.com/docs/guides/create-a-db-adapter),
[Better Auth account-schema explanation](https://better-auth.com/blog/1-7-account-schema),
and [Cosmos DB Linux emulator documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/emulator-linux).
