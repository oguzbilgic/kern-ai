# File migrations

File migrations upgrade existing agents before startup, `kern config`, and adoption through `kern init`. They use package semver values, with no separate schema counter. `config.json.version` records the last successful migration release; upgrading through releases without migrations leaves the stamp and files untouched. New agents are stamped with the installed package version. Missing stamps identify legacy agents; malformed stamps and stamps newer than the running package abort without writes.

## Adding a migration

Add a module under `src/migrations/` exporting a `Migration` and register it in `MIGRATIONS` in `src/migrations/index.ts`. Its `targetVersion` is the package version introducing the change. Development builds are versioned after the release they lead to (`0.44.0-next` precedes `0.44.0` in semver order), and a migration written during that cycle targets the same `-next` version so it runs on dev builds; the release commit bumps both `package.json` and the target to the release version (a test fails a release build that still carries a `-next` target). Keep historical targets fixed across later releases. Use one migration per release; combine related transformations in it. The runner orders migrations and applies those newer than the stored version and no newer than the installed package.

`migrate({ config, env })` returns the transformed raw config object and `.env` text (or `null` for an absent file). Transformations are synchronous and do not write files; the runner owns all backups and writes. Preserve unknown config fields and unrelated environment entries. Remove only specifically deprecated fields. Avoid materializing ordinary runtime defaults or converting valid string model shorthand without a semantic reason.

Make transformations idempotent and able to accept partially migrated files. Every file rename is atomic, but replacing config and `.env` together is not a filesystem transaction. A process can stop after replacing `.env` and before replacing config. For an environment-key rename, accept either the old key or the already-renamed key and produce the same config. Never remove the only source needed to finish the config transformation on retry. The initial connection migration retains legacy `.env` entries for this reason.

## Backup and failure behavior

The runner validates the final stored config, snapshots every affected existing file, verifies exact bytes, stages all replacements, and checks that target files still match what was read. Secrets stay in `.env` and its backups. Snapshot directories are private, snapshot files use mode `0600`, and backups are ignored by git even in older workspaces. `manifest.json` records absent targets for manual restoration. Original file permissions are preserved during replacement.

Replacements are staged inside the private, gitignored snapshot directory so a process interruption cannot leave credential files exposed to `git add`. Renames into `.kern/` require the backup directory to be on the same filesystem; a cross-device rename fails safely. The runner replaces `.env` first and config last. Config's version is the completion marker. Exceptions trigger restoration of already replaced files and temporary-file cleanup; errors include the snapshot path and identify any restoration failure. A hard process interruption requires a safe retry or manual restoration of the complete snapshot. Backup directories are retained until the user removes them.

The existing live-PID guard prevents migrations against an agent already running under another process. It is reused without adding a new locking protocol; simultaneous starts without an existing PID retain the limitations of the current startup guard. Do not move migrations into the read-only `loadConfig()` path. SQLite and vector-index migrations remain owned by the memory database.

Test legacy conversion, skipped releases, unchanged ordinary upgrades, interrupted retries, snapshot/staging/replacement failures, and preservation of unrelated settings. Update `CHANGELOG.md` and the relevant configuration documentation with the exact conversion and any remaining manual action.
