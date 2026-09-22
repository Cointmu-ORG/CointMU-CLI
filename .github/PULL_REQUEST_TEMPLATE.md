## Description

What changed and why. For a bug fix, say what the root cause was, not just the symptom.

## Related issue

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update
- [ ] Refactor (no behavior change)

## Testing performed

- [ ] Unit tests added or updated
- [ ] `npm test` passes locally
- [ ] Manual testing of the affected commands
- [ ] Tested against a tarball install (`npm run build && npm pack`, then install the tarball with `--prefix` into an empty directory) — required for packaging, `bin`, or `files` changes

Describe what you actually ran, including the before/after output if the change is user-visible:

## Checklist

- [ ] `npm run build` and lint are clean
- [ ] Documentation (README, command help text) updated, or not needed
- [ ] No breaking changes, or the breaking change is described above and in the PR title
- [ ] If the fix touches a shared helper, I checked its other callers

## Release notes

- [ ] Needs its own release (security fix, or a bug that blocks current users)
- [ ] Can ship with the next release
- [ ] No release needed (docs, CI, tooling)
