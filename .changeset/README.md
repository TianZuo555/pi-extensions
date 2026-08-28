# Changesets

Every publishable extension change needs a changeset. Run:

```bash
pnpm changeset
```

Select the affected package, choose the semantic version bump, and write the
user-facing release note. Commit the generated Markdown file with the change.
Do not edit package versions or changelogs manually.

After changes reach `main`, the publish workflow opens or updates a release PR.
Merging that PR publishes each changed package, updates its `CHANGELOG.md`, and
creates a package-specific GitHub release.
