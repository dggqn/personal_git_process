import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

type SyncStrategy = "rebase" | "merge";

type BlockStatus = "local" | "public" | "conflict";

interface GitResult {
  stdout: string;
  stderr: string;
}

interface LocalBlockState {
  version: number;
  blocks: LocalBlock[];
}

interface LocalBlock {
  id: string;
  file: string;
  baseText: string;
  localText: string;
  baseHash: string;
  localHash: string;
  contextBefore: string[];
  contextAfter: string[];
  status: BlockStatus;
  createdAt: string;
  updatedAt: string;
}

interface BlockLocation {
  block: LocalBlock;
  index: number;
  currentText: string;
  matchedBy: "base" | "local";
}

interface ApplyResult {
  applied: number;
  conflicts: number;
}

interface RestoreResult {
  restored: number;
  conflicts: number;
}

const STATE_VERSION = 1;
const LOCAL_BLOCKS_DIR = ["local-blocks"];
const STATE_FILE = "state.json";
const HOOKS_DIR = "hooks";
const PRE_COMMIT_FILE = "pre-commit";
const CONTEXT_LINES = 2;

const output = vscode.window.createOutputChannel("Personal Git Process");

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(git-branch) Personal Git";
  statusBar.tooltip = "Run Personal Git Process sync";
  statusBar.command = "personalGitProcess.syncWorkspace";
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand("personalGitProcess.syncWorkspace", () =>
      runCommand("Sync Workspace", syncWorkspace)
    ),
    vscode.commands.registerCommand("personalGitProcess.safePush", () => runCommand("Safe Push", safePush)),
    vscode.commands.registerCommand("personalGitProcess.protectSelection", () =>
      runCommand("Protect Selection as Local Block", protectSelectionAsLocalBlock)
    ),
    vscode.commands.registerCommand("personalGitProcess.applyLocalBlocks", () =>
      runCommand("Apply Local Blocks", applyLocalBlocksCommand)
    ),
    vscode.commands.registerCommand("personalGitProcess.showPublicVersion", () =>
      runCommand("Show Public Version", showPublicVersionCommand)
    ),
    vscode.commands.registerCommand("personalGitProcess.safeSyncLocalBlocks", () =>
      runCommand("Safe Sync With Local Blocks", safeSyncWithLocalBlocks)
    ),
    vscode.commands.registerCommand("personalGitProcess.installPreCommitGuard", () =>
      runCommand("Install Local Block Pre-Commit Guard", installPreCommitGuardCommand)
    ),
    vscode.commands.registerCommand("personalGitProcess.openOutput", () => output.show(true))
  );
}

export function deactivate(): void {
  // Output disposal is handled by context subscriptions.
}

async function protectSelectionAsLocalBlock(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a file and select code before creating a local block.");
    return;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    vscode.window.showWarningMessage("Select the code that should become a local block first.");
    return;
  }

  const repoPath = await pickRepositoryForFile(editor.document.uri.fsPath);
  if (!repoPath) {
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(repoPath);

  const absoluteFile = editor.document.uri.fsPath;
  const relativeFile = toPosixPath(path.relative(repoPath, absoluteFile));
  if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) {
    vscode.window.showWarningMessage("The selected file is not inside the selected repository.");
    return;
  }

  const localText = editor.document.getText(selection);
  const id = await vscode.window.showInputBox({
    title: "Local block id",
    prompt: "Name this local-only code block.",
    value: suggestBlockId(relativeFile),
    ignoreFocusOut: true,
    validateInput: (value) => validateBlockId(value)
  });

  if (!id) {
    log("Protect selection cancelled: no block id provided.");
    return;
  }

  const blockId = id.trim();
  const state = await readLocalBlockState(repoPath);
  const duplicate = state.blocks.find((block) => block.file === relativeFile && block.id === blockId);
  if (duplicate) {
    vscode.window.showWarningMessage(`Local block ${relativeFile}#${blockId} already exists.`);
    return;
  }

  const baseText = await resolveBaseText(repoPath, relativeFile, editor, selection, localText);
  if (baseText === undefined) {
    return;
  }

  const documentLines = editor.document.getText().split(/\r?\n/);
  const block: LocalBlock = {
    id: blockId,
    file: relativeFile,
    baseText,
    localText,
    baseHash: hashText(baseText),
    localHash: hashText(localText),
    contextBefore: getContextBefore(documentLines, selection.start.line),
    contextAfter: getContextAfter(documentLines, selection.end.line),
    status: "local",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  state.blocks.push(block);
  await writeLocalBlockState(repoPath, state);

  vscode.window.showInformationMessage(`Local block saved: ${relativeFile}#${block.id}`);
  log(`Local block saved: ${relativeFile}#${block.id}`);
}

async function applyLocalBlocksCommand(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(repoPath);
  const result = await applyLocalBlocks(repoPath);

  if (result.conflicts > 0) {
    vscode.window.showWarningMessage(
      `Applied ${result.applied} local block(s), ${result.conflicts} need manual handling. See output for details.`
    );
    return;
  }

  vscode.window.showInformationMessage(`Applied ${result.applied} local block(s).`);
}

async function showPublicVersionCommand(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(repoPath);
  const result = await restorePublicVersion(repoPath);

  if (result.conflicts > 0) {
    vscode.window.showWarningMessage(
      `Restored ${result.restored} local block(s), ${result.conflicts} need manual handling. See output for details.`
    );
    return;
  }

  vscode.window.showInformationMessage(`Restored public version for ${result.restored} local block(s).`);
}

async function installPreCommitGuardCommand(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(repoPath);
  await installPreCommitGuard(repoPath);
  vscode.window.showInformationMessage("Local block pre-commit guard installed.");
}

async function safeSyncWithLocalBlocks(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Personal Git Process: Safe Sync With Local Blocks",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Checking repository state" });

      ensureOutputVisible();
      log(`Safe sync with local blocks start: ${repoPath}`);

      await ensureGitRepository(repoPath);
      const branch = await getCurrentBranch(repoPath);
      const upstream = await getOrPromptUpstream(repoPath, branch);
      const strategy = await pickSyncStrategy();

      if (!strategy) {
        log("Safe sync cancelled: no strategy selected.");
        return;
      }

      progress.report({ message: "Restoring public versions for local blocks" });
      const restoreResult = await restorePublicVersion(repoPath);
      if (restoreResult.conflicts > 0) {
        vscode.window.showWarningMessage(
          "Safe sync stopped: some local blocks could not be restored to public versions. See output for details."
        );
        return;
      }

      const hasChanges = await hasWorkingTreeChanges(repoPath);
      let stashCreated = false;
      let stashRef = "";

      if (hasChanges) {
        const choice = await vscode.window.showWarningMessage(
          "Detected local changes after local blocks were restored to public versions. Create a stash before syncing?",
          { modal: true },
          "Stash and Continue",
          "Cancel"
        );

        if (choice !== "Stash and Continue") {
          log("Safe sync cancelled because local changes were not stashed.");
          await applyLocalBlocks(repoPath);
          return;
        }

        stashRef = "stash@{0}";
        await git(repoPath, ["stash", "push", "-u", "-m", buildStashMessage()]);
        stashCreated = true;
        log(`Created stash ${stashRef}.`);
      }

      progress.report({ message: "Fetching remote updates" });
      await git(repoPath, ["fetch", "--all", "--prune"]);

      progress.report({ message: `Running ${strategy} against ${upstream}` });
      if (strategy === "rebase") {
        await git(repoPath, ["rebase", upstream]);
      } else {
        await git(repoPath, ["merge", "--no-edit", upstream]);
      }

      if (stashCreated) {
        progress.report({ message: "Re-applying stash" });
        try {
          await git(repoPath, ["stash", "apply", stashRef]);
          await git(repoPath, ["stash", "drop", stashRef]);
          log(`Dropped stash ${stashRef} after successful apply.`);
        } catch (error) {
          log(`Stash apply failed. Keeping ${stashRef} for manual recovery.`);
          throw error;
        }
      }

      progress.report({ message: "Applying local blocks" });
      const applyResult = await applyLocalBlocks(repoPath);
      if (applyResult.conflicts > 0) {
        vscode.window.showWarningMessage(
          `Sync completed, but ${applyResult.conflicts} local block(s) need manual handling. See output for details.`
        );
        return;
      }

      vscode.window.showInformationMessage(`Safe sync with local blocks completed on branch ${branch}.`);
      log(`Safe sync with local blocks finished successfully on ${branch}.`);
    }
  );
}

async function syncWorkspace(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Personal Git Process: Sync Workspace",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Checking repository state" });

      ensureOutputVisible();
      log(`Sync start: ${repoPath}`);

      await ensureGitRepository(repoPath);
      const branch = await getCurrentBranch(repoPath);
      const upstream = await getOrPromptUpstream(repoPath, branch);
      const strategy = await pickSyncStrategy();

      if (!strategy) {
        log("Sync cancelled: no strategy selected.");
        return;
      }

      const hasChanges = await hasWorkingTreeChanges(repoPath);
      let stashCreated = false;
      let stashRef = "";

      if (hasChanges) {
        const choice = await vscode.window.showWarningMessage(
          "Detected local changes. Create a stash before syncing?",
          { modal: true },
          "Stash and Continue",
          "Cancel"
        );

        if (choice !== "Stash and Continue") {
          log("Sync cancelled because local changes were not stashed.");
          return;
        }

        stashRef = "stash@{0}";
        await git(repoPath, ["stash", "push", "-u", "-m", buildStashMessage()]);
        stashCreated = true;
        log(`Created stash ${stashRef}.`);
      }

      progress.report({ message: "Fetching remote updates" });
      await git(repoPath, ["fetch", "--all", "--prune"]);

      progress.report({ message: `Running ${strategy} against ${upstream}` });
      if (strategy === "rebase") {
        await git(repoPath, ["rebase", upstream]);
      } else {
        await git(repoPath, ["merge", "--no-edit", upstream]);
      }

      if (stashCreated) {
        progress.report({ message: "Re-applying stash" });
        try {
          await git(repoPath, ["stash", "apply", stashRef]);
          await git(repoPath, ["stash", "drop", stashRef]);
          log(`Dropped stash ${stashRef} after successful apply.`);
        } catch (error) {
          log(`Stash apply failed. Keeping ${stashRef} for manual recovery.`);
          throw error;
        }
      }

      vscode.window.showInformationMessage(`Sync completed on branch ${branch}.`);
      log(`Sync finished successfully on ${branch}.`);
    }
  );
}

async function safePush(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Personal Git Process: Safe Push",
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Checking repository state" });

      ensureOutputVisible();
      log(`Safe push start: ${repoPath}`);

      await ensureGitRepository(repoPath);
      const branch = await getCurrentBranch(repoPath);
      const dirty = await hasWorkingTreeChanges(repoPath);

      if (dirty) {
        vscode.window.showWarningMessage("Push blocked: working tree has uncommitted changes.");
        log("Push blocked because working tree is dirty.");
        return;
      }

      const upstream = await getUpstreamBranch(repoPath);
      progress.report({ message: "Fetching remote updates" });
      await git(repoPath, ["fetch", "--all", "--prune"]);

      if (upstream) {
        const { behind, ahead } = await getAheadBehind(repoPath, upstream);
        log(`Ahead/behind against ${upstream}: ahead=${ahead}, behind=${behind}`);

        if (behind > 0) {
          vscode.window.showWarningMessage(
            `Push blocked: branch is behind ${upstream} by ${behind} commit(s). Sync first.`
          );
          return;
        }

        const proceed = await vscode.window.showInformationMessage(
          ahead > 0
            ? `Push ${ahead} local commit(s) from ${branch} to ${upstream}?`
            : `No local commits are ahead of ${upstream}. Push anyway?`,
          { modal: true },
          "Push",
          "Cancel"
        );

        if (proceed !== "Push") {
          log("Push cancelled by user.");
          return;
        }

        progress.report({ message: "Pushing to upstream" });
        await git(repoPath, ["push"]);
        vscode.window.showInformationMessage(`Push completed for ${branch}.`);
        log(`Push finished successfully on ${branch}.`);
        return;
      }

      const targetRemote = await vscode.window.showInputBox({
        title: "Set upstream remote",
        prompt: "Remote name for first push",
        value: "origin",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : "Remote is required")
      });

      if (!targetRemote) {
        log("Push cancelled because no remote was provided.");
        return;
      }

      const proceed = await vscode.window.showInformationMessage(
        `Push ${branch} and set upstream to ${targetRemote}/${branch}?`,
        { modal: true },
        "Push",
        "Cancel"
      );

      if (proceed !== "Push") {
        log("Initial push cancelled by user.");
        return;
      }

      progress.report({ message: "Pushing and setting upstream" });
      await git(repoPath, ["push", "--set-upstream", targetRemote, branch]);
      vscode.window.showInformationMessage(`Push completed and upstream set to ${targetRemote}/${branch}.`);
      log(`Push finished successfully on ${branch} with upstream ${targetRemote}/${branch}.`);
    }
  );
}

async function pickRepository(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage("Open a folder or workspace before running Personal Git Process.");
    return undefined;
  }

  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }

  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      path: folder.uri.fsPath
    })),
    {
      title: "Choose repository folder",
      ignoreFocusOut: true
    }
  );

  return selected?.path;
}

async function pickRepositoryForFile(filePath: string): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage("Open a folder or workspace before running Personal Git Process.");
    return undefined;
  }

  const candidates = folders
    .map((folder) => folder.uri.fsPath)
    .filter((folderPath) => isPathInside(filePath, folderPath))
    .sort((left, right) => right.length - left.length);

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length > 1) {
    const selected = await vscode.window.showQuickPick(
      candidates.map((folderPath) => ({
        label: path.basename(folderPath),
        description: folderPath,
        path: folderPath
      })),
      {
        title: "Choose repository folder",
        ignoreFocusOut: true
      }
    );

    return selected?.path;
  }

  return pickRepository();
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureGitRepository(repoPath: string): Promise<void> {
  await git(repoPath, ["rev-parse", "--show-toplevel"]);
}

async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = result.stdout.trim();

  if (branch === "HEAD") {
    throw new Error("Detached HEAD is not supported by this workflow.");
  }

  return branch;
}

async function getUpstreamBranch(repoPath: string): Promise<string | undefined> {
  try {
    const result = await git(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

async function getOrPromptUpstream(repoPath: string, branch: string): Promise<string> {
  const upstream = await getUpstreamBranch(repoPath);
  if (upstream) {
    return upstream;
  }

  const value = await vscode.window.showInputBox({
    title: "Upstream branch",
    prompt: "No upstream detected. Enter a branch reference to sync against.",
    value: `origin/${branch}`,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? undefined : "Upstream branch is required")
  });

  if (!value) {
    throw new Error("Sync cancelled because no upstream branch was provided.");
  }

  return value.trim();
}

async function pickSyncStrategy(): Promise<SyncStrategy | undefined> {
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "Rebase",
        description: "Keep history linear by rebasing onto upstream",
        value: "rebase" as const
      },
      {
        label: "Merge",
        description: "Create a merge commit when needed",
        value: "merge" as const
      }
    ],
    {
      title: "Choose sync strategy",
      ignoreFocusOut: true
    }
  );

  return selected?.value;
}

async function hasWorkingTreeChanges(repoPath: string): Promise<boolean> {
  const result = await git(repoPath, ["status", "--porcelain"]);
  return result.stdout.trim().length > 0;
}

async function getAheadBehind(
  repoPath: string,
  upstream: string
): Promise<{ behind: number; ahead: number }> {
  const result = await git(repoPath, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  const [behindRaw, aheadRaw] = result.stdout.trim().split(/\s+/);

  return {
    behind: Number.parseInt(behindRaw ?? "0", 10),
    ahead: Number.parseInt(aheadRaw ?? "0", 10)
  };
}

async function applyLocalBlocks(repoPath: string): Promise<ApplyResult> {
  const state = await readLocalBlockState(repoPath);
  let applied = 0;
  let conflicts = 0;
  let changed = false;

  for (const block of state.blocks) {
    const filePath = path.join(repoPath, fromPosixPath(block.file));
    let text: string;

    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      conflicts += 1;
      block.status = "conflict";
      block.updatedAt = new Date().toISOString();
      changed = true;
      log(`Local block conflict ${block.file}#${block.id}: file cannot be read (${String(error)}).`);
      continue;
    }

    const location = findBlockLocation(text, block);
    if (!location) {
      conflicts += 1;
      block.status = "conflict";
      block.updatedAt = new Date().toISOString();
      changed = true;
      log(`Local block conflict ${block.file}#${block.id}: base/local text not found.`);
      continue;
    }

    if (location.matchedBy === "local") {
      block.status = "local";
      block.updatedAt = new Date().toISOString();
      changed = true;
      log(`Local block already applied: ${block.file}#${block.id}`);
      continue;
    }

    const updated = replaceAt(text, location.index, location.currentText, block.localText);
    await fs.writeFile(filePath, updated, "utf8");
    block.status = "local";
    block.updatedAt = new Date().toISOString();
    applied += 1;
    changed = true;
    log(`Applied local block: ${block.file}#${block.id}`);
  }

  if (changed) {
    await writeLocalBlockState(repoPath, state);
  }

  return { applied, conflicts };
}

async function restorePublicVersion(repoPath: string): Promise<RestoreResult> {
  const state = await readLocalBlockState(repoPath);
  let restored = 0;
  let conflicts = 0;
  let changed = false;

  for (const block of state.blocks) {
    const filePath = path.join(repoPath, fromPosixPath(block.file));
    let text: string;

    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      conflicts += 1;
      block.status = "conflict";
      block.updatedAt = new Date().toISOString();
      changed = true;
      log(`Local block conflict ${block.file}#${block.id}: file cannot be read (${String(error)}).`);
      continue;
    }

    const location = findBlockLocation(text, block);
    if (!location) {
      conflicts += 1;
      block.status = "conflict";
      block.updatedAt = new Date().toISOString();
      changed = true;
      log(`Local block conflict ${block.file}#${block.id}: base/local text not found.`);
      continue;
    }

    if (location.matchedBy === "base") {
      block.status = "public";
      block.updatedAt = new Date().toISOString();
      changed = true;
      log(`Local block already public: ${block.file}#${block.id}`);
      continue;
    }

    const updated = replaceAt(text, location.index, location.currentText, block.baseText);
    await fs.writeFile(filePath, updated, "utf8");
    block.status = "public";
    block.updatedAt = new Date().toISOString();
    restored += 1;
    changed = true;
    log(`Restored public version: ${block.file}#${block.id}`);
  }

  if (changed) {
    await writeLocalBlockState(repoPath, state);
  }

  return { restored, conflicts };
}

async function resolveBaseText(
  repoPath: string,
  relativeFile: string,
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  localText: string
): Promise<string | undefined> {
  const gitContent = await readFileFromHead(repoPath, relativeFile);
  if (!gitContent) {
    const value = await vscode.window.showInputBox({
      title: "Public version for local block",
      prompt: "This file is not available in HEAD. Enter the public version that should be committed.",
      value: localText,
      ignoreFocusOut: true
    });
    return value;
  }

  const workspaceContent = editor.document.getText();
  const currentSelectionOffset = editor.document.offsetAt(selection.start);
  const headRange = mapWorkspaceSelectionToHeadRange(workspaceContent, gitContent, currentSelectionOffset, localText);
  if (headRange) {
    return gitContent.slice(headRange.start, headRange.end);
  }

  const value = await vscode.window.showInputBox({
    title: "Public version for local block",
    prompt: "Could not infer the public version from HEAD. Edit the text that should be committed instead.",
    value: localText,
    ignoreFocusOut: true
  });

  return value;
}

async function readFileFromHead(repoPath: string, relativeFile: string): Promise<string | undefined> {
  try {
    const result = await git(repoPath, ["show", `HEAD:${relativeFile}`]);
    return result.stdout;
  } catch {
    return undefined;
  }
}

function mapWorkspaceSelectionToHeadRange(
  workspaceContent: string,
  headContent: string,
  selectionOffset: number,
  localText: string
): { start: number; end: number } | undefined {
  if (workspaceContent === headContent) {
    return { start: selectionOffset, end: selectionOffset + localText.length };
  }

  if (headContent.includes(localText)) {
    const start = headContent.indexOf(localText);
    return { start, end: start + localText.length };
  }

  const before = workspaceContent.slice(0, selectionOffset);
  const after = workspaceContent.slice(selectionOffset + localText.length);
  const beforeAnchor = getAnchor(before, "end");
  const afterAnchor = getAnchor(after, "start");

  if (beforeAnchor && afterAnchor) {
    const beforeIndex = headContent.indexOf(beforeAnchor);
    if (beforeIndex >= 0) {
      const start = beforeIndex + beforeAnchor.length;
      const afterIndex = headContent.indexOf(afterAnchor, start);
      if (afterIndex >= start) {
        return { start, end: afterIndex };
      }
    }
  }

  return undefined;
}

function getAnchor(text: string, side: "start" | "end"): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const selected = side === "start" ? lines.slice(0, CONTEXT_LINES) : lines.slice(-CONTEXT_LINES);
  return selected.join("\n");
}

async function installPreCommitGuard(repoPath: string): Promise<void> {
  const hooksPath = path.join(await getGitDir(repoPath), HOOKS_DIR);
  await fs.mkdir(hooksPath, { recursive: true });

  const hookPath = path.join(hooksPath, PRE_COMMIT_FILE);
  const hookContent = buildPreCommitHook();

  let existing = "";
  try {
    existing = await fs.readFile(hookPath, "utf8");
  } catch {
    // No existing hook; the new guard can own the file.
  }

  if (existing.includes("personal-git-process local-block guard")) {
    log("Pre-commit guard already installed.");
    return;
  }

  const finalContent = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${hookContent}` : hookContent;
  await fs.writeFile(hookPath, finalContent, "utf8");
  log(`Installed pre-commit guard at ${hookPath}`);
}

function buildPreCommitHook(): string {
  return `#!/bin/sh
# personal-git-process local-block guard
node <<'NODE'
const fs = require('fs');
const cp = require('child_process');
const path = require('path');

function git(args) {
  return cp.execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readState() {
  let gitDir;
  try {
    gitDir = git(['rev-parse', '--git-dir']);
  } catch (_) {
    return null;
  }

  const statePath = path.resolve(gitDir, 'local-blocks', 'state.json');
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    console.error('[personal-git-process] Cannot read local block state:', error.message);
    process.exit(1);
  }
}

const state = readState();
if (!state || !Array.isArray(state.blocks) || state.blocks.length === 0) {
  process.exit(0);
}

const leaked = [];
for (const block of state.blocks) {
  if (!block || !block.file || !block.localText) {
    continue;
  }

  let staged = '';
  try {
    staged = git(['show', ':' + block.file]);
  } catch (_) {
    continue;
  }

  if (staged.includes(block.localText)) {
    leaked.push(block.file + '#' + block.id);
  }
}

if (leaked.length > 0) {
  console.error('[personal-git-process] Commit blocked: staged content contains local-only blocks.');
  for (const item of leaked) {
    console.error('  - ' + item);
  }
  console.error('Run "Personal Git Process: Show Public Version", stage again, then commit.');
  process.exit(1);
}
NODE
`;
}

async function readLocalBlockState(repoPath: string): Promise<LocalBlockState> {
  const statePath = await getStatePath(repoPath);
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as LocalBlockState;
    return {
      version: parsed.version || STATE_VERSION,
      blocks: Array.isArray(parsed.blocks) ? parsed.blocks : []
    };
  } catch {
    return { version: STATE_VERSION, blocks: [] };
  }
}

async function writeLocalBlockState(repoPath: string, state: LocalBlockState): Promise<void> {
  const dirPath = await getLocalBlocksDir(repoPath);
  await fs.mkdir(dirPath, { recursive: true });
  const statePath = path.join(dirPath, STATE_FILE);
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function getLocalBlocksDir(repoPath: string): Promise<string> {
  return path.join(await getGitDir(repoPath), ...LOCAL_BLOCKS_DIR);
}

async function getStatePath(repoPath: string): Promise<string> {
  return path.join(await getLocalBlocksDir(repoPath), STATE_FILE);
}

async function getGitDir(repoPath: string): Promise<string> {
  const result = await git(repoPath, ["rev-parse", "--git-dir"]);
  const value = result.stdout.trim();
  return path.isAbsolute(value) ? value : path.join(repoPath, value);
}

function findBlockLocation(text: string, block: LocalBlock): BlockLocation | undefined {
  const localIndex = text.indexOf(block.localText);
  if (localIndex >= 0) {
    return { block, index: localIndex, currentText: block.localText, matchedBy: "local" };
  }

  const baseIndex = text.indexOf(block.baseText);
  if (baseIndex >= 0) {
    return { block, index: baseIndex, currentText: block.baseText, matchedBy: "base" };
  }

  return undefined;
}

function replaceAt(text: string, index: number, currentText: string, nextText: string): string {
  return `${text.slice(0, index)}${nextText}${text.slice(index + currentText.length)}`;
}

function getContextBefore(lines: string[], startLine: number): string[] {
  return lines.slice(Math.max(0, startLine - CONTEXT_LINES), startLine);
}

function getContextAfter(lines: string[], endLine: number): string[] {
  return lines.slice(endLine + 1, endLine + 1 + CONTEXT_LINES);
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function suggestBlockId(relativeFile: string): string {
  return path
    .basename(relativeFile)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .toLowerCase();
}

function validateBlockId(value: string): string | undefined {
  if (!value.trim()) {
    return "Block id is required";
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(value.trim())) {
    return "Use only letters, numbers, dot, underscore, or dash";
  }

  return undefined;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function fromPosixPath(value: string): string {
  return value.split("/").join(path.sep);
}

function buildStashMessage(): string {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("-") + " " + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join(":");

  return `personal-git-process ${timestamp}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function git(repoPath: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    log(`git ${args.join(" ")}`, repoPath);

    execFile(
      "git",
      args,
      {
        cwd: repoPath,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (stdout.trim()) {
          log(stdout.trim());
        }

        if (stderr.trim()) {
          log(stderr.trim());
        }

        if (error) {
          const message = stderr.trim() || stdout.trim() || error.message;
          const wrapped = new Error(message);
          vscode.window.showErrorMessage(`Git command failed: ${message}`);
          reject(wrapped);
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

function ensureOutputVisible(): void {
  output.show(true);
}

function log(message: string, repoPath?: string): void {
  const prefix = new Date().toLocaleTimeString();
  const location = repoPath ? ` [${path.basename(repoPath)}]` : "";
  output.appendLine(`${prefix}${location} ${message}`);
}

async function runCommand(name: string, handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${name} failed: ${message}`);
    vscode.window.showErrorMessage(`${name} failed: ${message}`);
  }
}
