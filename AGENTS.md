# Agent rules

## Release every shipped change

Pi installs this package from an immutable version tag. A fix reaches no machine until it has a new tag and the pin in `pi-dotfiles` points at it. After a change to runtime code is committed and its tests pass, finish all of these steps:

1. Bump the patch version: `npm version <x.y.z> --no-git-tag-version`. Commit `package.json` and `package-lock.json` with the change.
2. Tag the commit `v<x.y.z>` and push `main` and the tag.
3. The release workflow creates the GitHub release from the commit subjects. Then replace its title and notes with a plain-language summary of what changed for users: `gh release edit v<x.y.z> --title "v<x.y.z>: <summary>" --notes "<notes>"`. If the workflow fails, create the release by hand with `gh release create`.
4. In `~/Repositories/pi-dotfiles`, update the pin in `settings.json`, run `./bin/pi-package-lock-refresh`, and commit and push both files.
5. Check out the new tag in the live package directory under `~/.pi/agent/git/github.com/longweekendprojects/`. Running sessions pick it up only after a reload.

Skip a release only for changes that do not affect installed behavior, such as edits to `tasks/` notes or tests alone.

## Tests

Run `npm test` before tagging. A new bug fix needs a test that fails without the fix.
