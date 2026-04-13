import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";

type SyncStrategy = "rebase" | "merge";

interface GitResult {
  stdout: string;
  stderr: string;
}

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
    vscode.commands.registerCommand("personalGitProcess.openOutput", () => output.show(true))
  );
}

export function deactivate(): void {
  // Output disposal is handled by context subscriptions.
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
