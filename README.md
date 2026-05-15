# Personal Git Process

`Personal Git Process` is a personal VS Code Git helper. It keeps risky Git steps explicit, and now includes an MVP for "local blocks": small pieces of code that you want to keep only on this machine.

## Commands

- `Personal Git Process: Sync Workspace`
  - Fetches remote updates, then rebases or merges the current branch.
  - If the working tree is dirty, it asks before creating a stash.
- `Personal Git Process: Safe Push`
  - Blocks push when the working tree is dirty or the current branch is behind upstream.
- `Personal Git Process: Protect Selection as Local Block`
  - Saves the selected code as a local-only block in `.git/local-blocks/state.json`.
  - The saved state lives inside `.git`, so it is local to this clone and is not committed.
- `Personal Git Process: Apply Local Blocks`
  - Replaces public code with the saved local-only code.
- `Personal Git Process: Show Public Version`
  - Replaces local-only code with the public version that should be committed.
- `Personal Git Process: Safe Sync With Local Blocks`
  - Shows public versions first, syncs remote updates, then reapplies local blocks.
  - If a block can no longer be found, it stops and reports a conflict in the output panel.
- `Personal Git Process: Install Local Block Pre-Commit Guard`
  - Installs a local `.git/hooks/pre-commit` guard.
  - The guard blocks commits when staged content still contains saved local-only text.
- `Personal Git Process: Open Output`
  - Opens the extension output channel.

## Local Blocks MVP Flow

1. Open a tracked file.
2. Select the lines that should stay local to your machine.
3. Run `Personal Git Process: Protect Selection as Local Block`.
4. Enter a block id, for example `local-api-url`.
5. The extension saves:
   - `baseText`: the public version from `HEAD`
   - `localText`: your selected local version
   - file path, hashes, and small context hints
6. Before committing, run `Personal Git Process: Show Public Version`, stage, and commit.
7. After syncing or when you want your local settings back, run `Personal Git Process: Apply Local Blocks`.

For normal update work, use `Personal Git Process: Safe Sync With Local Blocks`. It restores public text, runs the existing sync flow, then reapplies local text.

## Where Local Data Is Stored

Local block data is stored here inside each repository:

```text
.git/local-blocks/state.json
```

That file is not part of the project tree and is not pushed to the remote. If you clone the project again, local blocks must be created again.

## Current MVP Limits

- It works by text replacement, not by AST parsing.
- It supports single continuous selections.
- If the same selected text appears many times, the first matching occurrence is used.
- If the public or local text cannot be found later, the block is marked as a conflict and the output panel explains which block failed.
- This MVP does not yet use Git clean/smudge filters, so `Show Public Version` before staging is still the safest workflow.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

## Package

```bash
npm run compile
npm run package
```
