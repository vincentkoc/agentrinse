# Releasing

## First Publish

The unscoped `agentrinse` name was unclaimed when version 0.1 was prepared.
Registry availability must be checked again immediately before publishing.

Trusted publishing cannot be configured until the package exists. Bootstrap
the package once from a maintainer machine with npm account 2FA:

```bash
pnpm check
pnpm pack:check
npm publish --access public
```

This is the only release that should require local registry credentials.

## Trusted Publisher

After the first publish:

1. configure the npm package trusted publisher for GitHub Actions
2. select repository `vincentkoc/agentrinse`
3. select workflow `.github/workflows/release.yml`
4. select environment `npm`
5. protect the GitHub `npm` environment with the desired reviewer policy

The workflow uses GitHub-hosted runners, OIDC `id-token: write`, and npm
11.18.0. It does not require a long-lived npm token.

The repository is private, so npm provenance is unavailable until the source
repository is public. Trusted publishing authentication still avoids a
long-lived publish secret.

## Subsequent Releases

1. update `package.json`, `src/version.ts`, and `CHANGELOG.md`
2. run `pnpm check`, `pnpm smoke`, and `pnpm pack:check`
3. verify the packed tarball in Crabbox
4. push the exact validated commit
5. publish a GitHub release tagged `v<package-version>`
6. verify the Release workflow, npm version, package contents, and CLI smoke

The workflow refuses tags that do not exactly match `package.json`.
