# Contributing

## Setting up

```bash
pnpm install
pnpm exec playwright install chromium-headless-shell
pnpm check
```

Tests need Docker. Each run starts one PostgreSQL container; each test file works in a database of its own.

## Where things are

| Path      | Holds                                                                              |
| --------- | ---------------------------------------------------------------------------------- |
| `sql/`    | Keyturn itself: roles, tables, functions, views. Installed in file order           |
| `src/`    | The TypeScript client, the command line, the review page's server, the tool server |
| `review/` | The review page: one HTML file, one stylesheet, one script, no build step          |
| `test/`   | Tests, against real PostgreSQL                                                     |
| `python/` | The Python client and its tests, run with `uv`                                     |

## Rules for changes

- **A change to `sql/` comes with a test that tries to break it.** For anything that touches who may do what, add the attack to `test/attacks.test.ts`.
- **Functions that run with their owner's rights set `search_path = pg_catalog`** and take identity from `session_user`, never from an argument.
- **Nothing an agent wrote is printed raw.** Terminal output goes through `plain()`; the page uses `textContent`. The rule for which characters count as hidden is in `src/render.ts` and `review/hidden.js`, and a test holds the two together.
- **Every function sets `search_path = pg_catalog, pg_temp`.** Naming the temporary schema last is what stops a session's temporary tables and types standing in for the server's.
- **Run the suite on the oldest supported version too:** `POSTGRES_IMAGE=postgres:15 pnpm test`.
- **Runtime dependencies stay at one**, the PostgreSQL driver. Anything else needs a reason in the pull request.

Logins belong to the whole server, and test files run side by side. A test that makes a faulty login names it `wrong_<database>_...` and removes it, and tests that read `keyturn.doctor()` look only at their own findings.

## Commits

The hooks in `.githooks` refuse credentials and personal paths. `pnpm install` turns them on.
