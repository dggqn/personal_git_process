# Personal Git Process

`Personal Git Process` is a VS Code extension for a personal Git workflow that favors safety over hidden automation.

## MVP commands

- `Personal Git Process: Sync Workspace`
  - Detects dirty changes
  - Optionally creates a timestamped stash
  - Fetches remote updates
  - Syncs the current branch with its upstream using `rebase` or `merge`
  - Re-applies the stash and drops it only after a successful restore
- `Personal Git Process: Safe Push`
  - Verifies the current branch
  - Fetches remote updates
  - Blocks push when the branch is behind its upstream
  - Pushes to the tracked upstream or sets upstream on first push
- `Personal Git Process: Open Output`
  - Opens a dedicated output channel with full command logs

## How it works

The extension runs the local `git` executable with explicit commands. It does not depend on the VS Code built-in Git extension.

Supported flow:

1. Save current work
2. Stash local changes with a timestamped message when needed
3. Fetch remote updates
4. Sync with upstream branch by `rebase` or `merge`
5. Re-apply the stash
6. Push safely after checks pass

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Packaging

```bash
npm install
npm run compile
npm run package
```

This produces a `.vsix` file you can test locally or publish later.

## Notes

- The extension expects `git` to be available in `PATH`.
- On multi-root workspaces, the extension lets you choose which folder to operate on.
- If stash re-apply fails, the stash is intentionally kept so you can recover manually.
