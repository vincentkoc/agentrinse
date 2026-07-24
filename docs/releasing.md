# Releasing

## Reservation Publish

The unscoped `agentrinse` name was unclaimed when `0.0.0` was prepared.
Registry availability must be checked again immediately before publishing.

Trusted publishing cannot be configured until the package exists. Bootstrap
the unsupported reservation package once from a maintainer machine with npm
account 2FA:

```bash
pnpm check
pnpm pack:check
npm publish --access public
```

Verify that `npm view agentrinse@0.0.0` succeeds and that a clean global install
reports `0.0.0`. This is the only release that should require local registry
credentials. Create the `v0.0.0` GitHub release only after that verification.
The release workflow compares every extracted registry package file with the
tagged source instead of trying to publish the reservation package again.

## Trusted Publisher

After the first publish:

1. configure the npm package trusted publisher for GitHub Actions
2. select repository `vincentkoc/agentrinse`
3. select workflow `.github/workflows/release.yml`
4. select environment `npm`
5. protect the GitHub `npm` environment with the desired reviewer policy

The workflow uses GitHub-hosted runners, OIDC `id-token: write`, and npm
11.18.0. It does not require a long-lived npm token.

The repository is public. Trusted publishing automatically emits npm
provenance and avoids a long-lived publish secret.

## Supported Releases

1. update `package.json`, `src/version.ts`, and `CHANGELOG.md`
2. run `pnpm check`, `pnpm smoke`, and `pnpm pack:check`
3. verify the packed tarball in Crabbox
4. push the exact validated commit
5. publish a GitHub release tagged `v<package-version>`
6. verify the Release workflow, npm version, package contents, and CLI smoke

The workflow refuses tags that do not exactly match `package.json`.

If a release-triggered run fails because its tagged commit contains obsolete
release automation, rerun the current workflow manually with `release_tag` set
to that existing tag. The workflow checks out the selected tag before
verification or publishing.

The first supported release is `0.1.0`. Never advertise `0.0.0` for cleanup
against real developer state.
