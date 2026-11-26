# Writing cleanup rules

Start in `src/rules/<owner>/`. A built-in rule describes what its owner can regenerate and which evidence permits an action. The matching examples live under `test/rules/fixtures/<owner>/`.

| Change                                                    | Working example                                                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quarantine one file with a known name                     | [Claude changelog cache](../src/rules/claude/changelog-cache.json) and its [fixture](../test/rules/fixtures/claude/changelog-cache.json)                                    |
| Inspect direct children of a directory                    | [Claude debug logs](../src/rules/claude/debug-log.json) and their [fixture](../test/rules/fixtures/claude/debug-log.json)                                                   |
| Use an app's platform-specific log directory              | [Zed rotated log](../src/rules/zed/rotated-log.json) and its [fixture](../test/rules/fixtures/zed/rotated-log.json)                                                         |
| Recognize a rebuildable directory in a configured project | [Cargo output](../src/rules/cargo/build-output.json) and its [fixture](../test/rules/fixtures/cargo/build-output.json)                                                      |
| Add a resource that an app owns and maintains itself      | [Cursor inventory](../src/rules/cursor/inventory.ts) and its [native maintenance classifier](../src/rules/cursor/native-maintenance.ts)                                     |
| Interpret system evidence from a native API               | [Docker build cache](../src/rules/docker/build-cache.ts), [Git worktrees](../src/rules/git/worktree.ts), and [Codex database vacuum](../src/rules/codex/database-vacuum.ts) |

## Add a rule and its fixture

1. Copy the closest JSON example into the owner's directory. Set its ID to `<owner>.<filename-without-extension>`. The [descriptor schema](../schemas/cleanup-rule.schema.json) lists the supported fields.
2. Create a fixture at the same relative path under `test/rules/fixtures/`. Include accepted targets and nearby paths the rule must refuse. Use forward slashes in fixtures on every platform.
3. Run `pnpm rules:generate` to update the [built-in index](../src/rules/builtin.generated.ts). Commit the generated change alongside the descriptor and fixture.
4. Run `pnpm rules:verify`. It checks coverage and exercises the classifier and planner. File cases cover the age boundary and pending quarantine bytes. Project cases cover tracked and untracked output. Run `pnpm check` and the [package checks](../CONTRIBUTING.md) before opening a PR.

Cargo declares one rebuildable directory.

```json
{
  "id": "cargo.build-output",
  "kind": "project-artifacts",
  "names": ["target"]
}
```

The operator must select `target` for an explicit project. A match goes through the same project-root, Git, size, age, mount and process checks as the other [project artifacts](../src/adapters/artifacts/adapter.ts).

To require a cache declaration, set `"proof": "cachedir-tag"` in a project-artifact descriptor. The collector reads at most 45 bytes of the direct regular `CACHEDIR.TAG` file and checks its first line. Apply repeats the check before and after isolation. The marker declares a cache at the configured path. It cannot identify the process that wrote it. See the [format](https://bford.info/cachedir/spec.html) and the writers in [pytest](https://github.com/pytest-dev/pytest/blob/9.0.1/src/_pytest/cacheprovider.py#L225), [mypy](https://github.com/python/mypy/blob/v1.18.2/mypy/build.py#L1227) and [Ruff](https://github.com/astral-sh/ruff/blob/0.14.8/crates/ruff/src/cache.rs#L356).

## Choose the method

**Provider file quarantine.** Set the owner root, relative directory components, filename matcher, age and recovery window. `exact` discovery inspects one literal filename. `children` enumerates one bounded directory. An incomplete enumeration yields no candidates. The [shared collector](../src/adapters/provider-file-discovery.ts) pins identity before classification. Apply selects the matching rule again, resolves the configured owner, and verifies content and live holders. The original manifest governs recovery after a rule changes.

**Owner inventory.** An app's `inventory.ts` defines its default roots, observed resources and optional classifier. A classifier can return a finding or defer to the protected default. The [registry](../src/adapters/provider-specs.ts) lists installed provider rulesets in audit order. Use the [runtime list](../src/rules/runtime/tools.ts) for executable inventory.

**Native decisions.** Put owner-specific judgments under that owner's directory and collect live evidence in the adapter. OpenClaw's [shell snapshot rule](../src/rules/openclaw/shell-snapshot.json) uses the native traversal to check the shared database journal before capturing an identity. Docker's build-cache rule reports estimates while the daemon and worker identity cannot be bound to deletion. Each native descriptor names its collector. Registration rejects two rules that can claim the same file. A new action type needs its own plan, apply-time revalidation, journal and recovery contract.

## Before changing an action

1. Add a synthetic owner fixture for the changed decision. Include overlapping protections when their ordering affects the finding. Preserve absent optional fields, reason ordering, target keys, and stable action IDs when the evidence stays the same.
2. Follow the action through [apply](../src/core/apply.ts) and the resource's live revalidation. [File quarantine](../src/core/provider-file-revalidation.ts), [database vacuum](../src/core/database-revalidation.ts), [worktree quarantine](../src/core/worktree-revalidation.ts), and [artifact removal](../src/core/artifact-revalidation.ts) each have different owner proof. Artifact preflight and isolated removal share the [tree measurement check](../src/core/artifact-measurement.ts).
3. Check the journal and the recovery contract. [Provider files](../src/core/provider-file-recovery.ts) and [databases](../src/core/database-recovery.ts) have different recovery material. Git [undo](../src/core/worktree-undo.ts) and [purge](../src/core/worktree-purge.ts) revalidate registrations and recovery references. [Artifact removal](../src/core/artifact-executor.ts) verifies the isolated tree before permanent removal.
4. Run the [contributor checks](../CONTRIBUTING.md) with synthetic data. Changes to emitted contracts also require updated schema and plan verification fixtures.
