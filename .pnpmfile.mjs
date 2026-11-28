/**
 * Keeps a local registry mirror out of pnpm-lock.yaml.
 *
 * pnpr (pnpm's registry server, used here as a caching mirror of registry.npmjs.org) advertises
 * each tarball at `<registry>/<name>@<version>`. pnpm only leaves out URLs it can rebuild from the
 * npm layout, so it would record the mirror's host for every package resolved through it, and
 * CI, which resolves from npmjs, rejects those entries. Declaring `serverType: pnpr` would fix it
 * but is read only from this repo's pnpm-workspace.yaml, keyed by the mirror's URL.
 *
 * So drop a tarball URL exactly when it is the pnpr layout for that package and an integrity hash
 * is present: pnpm then rebuilds the npm-layout URL from whichever registry is configured (pnpr
 * serves that path too) and checks the same hash. Tarball and git dependencies are left alone.
 */
function isPnprLayout(key, resolution) {
  const { tarball, integrity } = resolution ?? {};
  return (
    typeof tarball === 'string' && typeof integrity === 'string' && tarball.endsWith(`/${key}`)
  );
}

export const hooks = {
  afterAllResolved(lockfile) {
    for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
      if (isPnprLayout(key, entry.resolution)) {
        delete entry.resolution.tarball;
      }
    }
    return lockfile;
  },
};
