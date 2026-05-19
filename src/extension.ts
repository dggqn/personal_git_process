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

type LocalBlockTreeStatus = BlockStatus | "missing";
type LocalBlockTreeNodeKind = "repository" | "file" | "block";
type SingleBlockActionResult = "changed" | "unchanged" | "conflict";

interface LocalBlockTreeNode {
  kind: LocalBlockTreeNodeKind;
  repoPath: string;
  file?: string;
  block?: LocalBlock;
  status?: LocalBlockTreeStatus;
  blockCount?: number;
}

interface LocalBlockTarget {
  repoPath: string;
  block: LocalBlock;
}

interface LocalBlockQuickPickItem extends vscode.QuickPickItem {
  target: LocalBlockTarget;
}

const STATE_VERSION = 1;
const LOCAL_BLOCKS_DIR = ["local-blocks"];
const STATE_FILE = "state.json";
const HOOKS_DIR = "hooks";
const PRE_COMMIT_FILE = "pre-commit";
const CONTEXT_LINES = 2;
const ANCHOR_CHARS = 300;
const FILTER_NAME = "personalGitProcessLocalBlocks";
const FILTER_SCRIPT_FILE = "filter.cjs";
const INFO_DIR = "info";
const ATTRIBUTES_FILE = "attributes";
const ATTRIBUTES_MARKER_BEGIN = "# personal-git-process local-blocks begin";
const ATTRIBUTES_MARKER_END = "# personal-git-process local-blocks end";

const output = vscode.window.createOutputChannel("Personal Git Process");
let localBlocksProvider: LocalBlocksTreeDataProvider | undefined;
const isChineseLocale = vscode.env.language.toLowerCase().startsWith("zh-cn");

function localizeText(english: string, chinese: string): string {
  return isChineseLocale ? chinese : english;
}

function t(template: string, values: Record<string, string | number> = {}): string {
  const englishMessages = {
    statusBarTooltip: "Run Personal Git Process sync",
    revealLocalBlock: "Reveal Local Block",
    commandSyncWorkspace: "Sync Workspace",
    commandSafePush: "Safe Push",
    commandProtectSelection: "Protect Selection as Local Block",
    commandApplyLocalBlocks: "Apply Local Blocks",
    commandShowPublicVersion: "Show Public Version",
    commandSafeSyncLocalBlocks: "Safe Sync With Local Blocks",
    commandInstallLocalBlockFilter: "Install Local Block Git Filter",
    commandInstallPreCommitGuard: "Install Local Block Pre-Commit Guard",
    commandRevealLocalBlock: "Reveal Local Block",
    commandApplyLocalBlock: "Apply Local Block",
    commandShowPublicBlock: "Show Public Block",
    commandApplyCurrentFileLocalBlock: "Apply Current File Local Block",
    commandShowCurrentFilePublicBlock: "Show Current File Public Block",
    commandUpdateLocalBlockFromSelection: "Update Local Block From Selection",
    commandDeleteLocalBlock: "Delete Local Block",
    openFileSelectCode: "Open a file and select code before creating a local block.",
    selectLocalBlockCode: "Select the code that should become a local block first.",
    selectedFileOutsideRepo: "The selected file is not inside the selected repository.",
    localBlockIdTitle: "Local block id",
    localBlockIdPrompt: "Name this local-only code block.",
    localBlockExists: "Local block {file}#{id} already exists.",
    localBlockSaved: "Local block saved: {file}#{id}",
    appliedWithConflicts:
      "Applied {applied} local block(s), {conflicts} need manual handling. See output for details.",
    appliedCount: "Applied {count} local block(s).",
    restoredWithConflicts:
      "Restored {restored} local block(s), {conflicts} need manual handling. See output for details.",
    restoredCount: "Restored public version for {count} local block(s).",
    chooseBlockReveal: "Choose a local block to reveal",
    blockNotFoundInFile: "Could not find {file}#{id} in the current file content.",
    chooseBlockApplyCurrentFile: "Choose a local block in the current file to apply",
    chooseBlockApply: "Choose a local block to apply",
    chooseBlockShowPublicCurrentFile: "Choose a local block in the current file to show as public",
    chooseBlockShowPublic: "Choose a local block to show as public",
    blockNeedsManualHandling: "{file}#{id} needs manual handling.",
    appliedBlock: "Applied local block: {file}#{id}",
    blockAlreadyApplied: "Local block already applied: {file}#{id}",
    restoredBlock: "Restored public version: {file}#{id}",
    blockAlreadyPublic: "Local block already public: {file}#{id}",
    openFileSelectNewContent: "Open a file and select the new local block content first.",
    selectNewContent: "Select the new local-only code before updating a local block.",
    chooseBlockUpdate: "Choose a local block to update",
    selectionMustBeInside: "Selection must be inside {file} before updating {id}.",
    blockNoLongerExists: "Local block no longer exists: {file}#{id}",
    updatedBlockFromSelection: "Updated local block from selection: {file}#{id}",
    chooseBlockDelete: "Choose a local block to delete",
    deleteBlockQuestion: "Delete local block {file}#{id}?",
    actionRestorePublicAndDelete: "Restore Public and Delete",
    actionKeepFileContentAndDelete: "Keep File Content and Delete",
    deleteStopped:
      "Delete stopped: {file}#{id} could not be restored automatically.",
    deletedBlock: "Deleted local block: {file}#{id}",
    preCommitGuardInstalled: "Local block pre-commit guard installed.",
    filterInstalled: "Local block Git filter installed.",
    progressSafeSync: "Personal Git Process: Safe Sync With Local Blocks",
    progressSync: "Personal Git Process: Sync Workspace",
    progressSafePush: "Personal Git Process: Safe Push",
    progressCheckingRepo: "Checking repository state",
    progressRestoringPublic: "Restoring public versions for local blocks",
    safeSyncRestoreStopped:
      "Safe sync stopped: some local blocks could not be restored to public versions. See output for details.",
    localChangesAfterPublic:
      "Detected local changes after local blocks were restored to public versions. Create a stash before syncing?",
    localChangesStashQuestion: "Detected local changes. Create a stash before syncing?",
    actionStashAndContinue: "Stash and Continue",
    actionCancel: "Cancel",
    progressFetching: "Fetching remote updates",
    progressRunningStrategy: "Running {strategy} against {upstream}",
    progressReapplyingStash: "Re-applying stash",
    progressApplyingBlocks: "Applying local blocks",
    syncCompletedWithConflicts:
      "Sync completed, but {conflicts} local block(s) need manual handling. See output for details.",
    safeSyncCompleted: "Safe sync with local blocks completed on branch {branch}.",
    syncCompleted: "Sync completed on branch {branch}.",
    pushBlockedDirty: "Push blocked: working tree has uncommitted changes.",
    pushBlockedBehind: "Push blocked: branch is behind {upstream} by {behind} commit(s). Sync first.",
    pushAheadQuestion: "Push {ahead} local commit(s) from {branch} to {upstream}?",
    pushNoAheadQuestion: "No local commits are ahead of {upstream}. Push anyway?",
    actionPush: "Push",
    pushCompleted: "Push completed for {branch}.",
    setUpstreamRemoteTitle: "Set upstream remote",
    setUpstreamRemotePrompt: "Remote name for first push",
    remoteRequired: "Remote is required",
    pushSetUpstreamQuestion: "Push {branch} and set upstream to {remote}/{branch}?",
    pushUpstreamCompleted: "Push completed and upstream set to {remote}/{branch}.",
    openFolderFirst: "Open a folder or workspace before running Personal Git Process.",
    chooseRepositoryFolder: "Choose repository folder",
    upstreamBranchTitle: "Upstream branch",
    upstreamBranchPrompt: "No upstream detected. Enter a branch reference to sync against.",
    upstreamRequired: "Upstream branch is required",
    chooseSyncStrategy: "Choose sync strategy",
    strategyRebase: "Rebase",
    strategyRebaseDescription: "Keep history linear by rebasing onto upstream",
    strategyMerge: "Merge",
    strategyMergeDescription: "Create a merge commit when needed",
    publicVersionTitle: "Public version for local block",
    publicVersionMissingPrompt:
      "This file is not available in HEAD. Enter the public version that should be committed.",
    publicVersionInferPrompt:
      "Could not infer the public version from HEAD. Edit the text that should be committed instead.",
    noLocalBlocksFound: "No local blocks found{suffix}.",
    activeFileSuffix: " in the active file",
    validateBlockIdRequired: "Block id is required",
    validateBlockIdChars: "Use only letters, numbers, dot, underscore, or dash",
    gitCommandFailed: "Git command failed: {message}",
    commandFailed: "{name} failed: {message}"
  };

  const chineseMessages: typeof englishMessages = {
    statusBarTooltip: "运行个人 Git 流程同步",
    revealLocalBlock: "定位本机块",
    commandSyncWorkspace: "同步工作区",
    commandSafePush: "安全推送",
    commandProtectSelection: "保护选区为本机块",
    commandApplyLocalBlocks: "应用所有本机块",
    commandShowPublicVersion: "显示公共版本",
    commandSafeSyncLocalBlocks: "带本机块安全同步",
    commandInstallLocalBlockFilter: "安装本机块 Git 过滤器",
    commandInstallPreCommitGuard: "安装本机块提交前检查",
    commandRevealLocalBlock: "定位本机块",
    commandApplyLocalBlock: "应用本机块",
    commandShowPublicBlock: "显示本机块公共版本",
    commandApplyCurrentFileLocalBlock: "应用当前文件本机块",
    commandShowCurrentFilePublicBlock: "显示当前文件公共版本",
    commandUpdateLocalBlockFromSelection: "用选区更新本机块",
    commandDeleteLocalBlock: "删除本机块",
    openFileSelectCode: "请先打开文件并选中要保护的代码。",
    selectLocalBlockCode: "请先选中要变成本机块的代码。",
    selectedFileOutsideRepo: "选中的文件不在所选仓库内。",
    localBlockIdTitle: "本机块 ID",
    localBlockIdPrompt: "给这段只保留在本机的代码起个名字。",
    localBlockExists: "本机块 {file}#{id} 已存在。",
    localBlockSaved: "已保存本机块：{file}#{id}",
    appliedWithConflicts: "已应用 {applied} 个本机块，{conflicts} 个需要手动处理。详情见输出日志。",
    appliedCount: "已应用 {count} 个本机块。",
    restoredWithConflicts: "已恢复 {restored} 个本机块为公共版本，{conflicts} 个需要手动处理。详情见输出日志。",
    restoredCount: "已将 {count} 个本机块恢复为公共版本。",
    chooseBlockReveal: "选择要定位的本机块",
    blockNotFoundInFile: "无法在当前文件内容中找到 {file}#{id}。",
    chooseBlockApplyCurrentFile: "选择当前文件中要应用的本机块",
    chooseBlockApply: "选择要应用的本机块",
    chooseBlockShowPublicCurrentFile: "选择当前文件中要显示公共版本的本机块",
    chooseBlockShowPublic: "选择要显示公共版本的本机块",
    blockNeedsManualHandling: "{file}#{id} 需要手动处理。",
    appliedBlock: "已应用本机块：{file}#{id}",
    blockAlreadyApplied: "本机块已经是本机版本：{file}#{id}",
    restoredBlock: "已恢复公共版本：{file}#{id}",
    blockAlreadyPublic: "本机块已经是公共版本：{file}#{id}",
    openFileSelectNewContent: "请先打开文件并选中新本机块内容。",
    selectNewContent: "请先选中新的本机专用代码。",
    chooseBlockUpdate: "选择要更新的本机块",
    selectionMustBeInside: "选区必须在 {file} 中，才能更新 {id}。",
    blockNoLongerExists: "本机块已不存在：{file}#{id}",
    updatedBlockFromSelection: "已用选区更新本机块：{file}#{id}",
    chooseBlockDelete: "选择要删除的本机块",
    deleteBlockQuestion: "确定删除本机块 {file}#{id} 吗？",
    actionRestorePublicAndDelete: "恢复公共版本并删除",
    actionKeepFileContentAndDelete: "保留文件内容并删除记录",
    deleteStopped: "删除已停止：{file}#{id} 无法自动恢复为公共版本。",
    deletedBlock: "已删除本机块：{file}#{id}",
    preCommitGuardInstalled: "已安装本机块提交前检查。",
    filterInstalled: "已安装本机块 Git 过滤器。",
    progressSafeSync: "个人 Git 流程：带本机块安全同步",
    progressSync: "个人 Git 流程：同步工作区",
    progressSafePush: "个人 Git 流程：安全推送",
    progressCheckingRepo: "正在检查仓库状态",
    progressRestoringPublic: "正在将本机块恢复为公共版本",
    safeSyncRestoreStopped: "安全同步已停止：部分本机块无法恢复为公共版本。详情见输出日志。",
    localChangesAfterPublic: "恢复公共版本后检测到本地改动。同步前是否先创建 stash？",
    localChangesStashQuestion: "检测到本地改动。同步前是否先创建 stash？",
    actionStashAndContinue: "Stash 并继续",
    actionCancel: "取消",
    progressFetching: "正在拉取远端更新",
    progressRunningStrategy: "正在对 {upstream} 执行 {strategy}",
    progressReapplyingStash: "正在重新应用 stash",
    progressApplyingBlocks: "正在应用本机块",
    syncCompletedWithConflicts: "同步已完成，但 {conflicts} 个本机块需要手动处理。详情见输出日志。",
    safeSyncCompleted: "带本机块安全同步完成，当前分支：{branch}。",
    syncCompleted: "同步完成，当前分支：{branch}。",
    pushBlockedDirty: "已阻止推送：工作区还有未提交改动。",
    pushBlockedBehind: "已阻止推送：当前分支落后 {upstream} {behind} 个提交。请先同步。",
    pushAheadQuestion: "是否将 {branch} 上的 {ahead} 个本地提交推送到 {upstream}？",
    pushNoAheadQuestion: "当前没有领先 {upstream} 的本地提交。仍然推送吗？",
    actionPush: "推送",
    pushCompleted: "{branch} 推送完成。",
    setUpstreamRemoteTitle: "设置 upstream 远端",
    setUpstreamRemotePrompt: "首次推送使用的远端名称",
    remoteRequired: "远端名称必填",
    pushSetUpstreamQuestion: "是否推送 {branch} 并将 upstream 设置为 {remote}/{branch}？",
    pushUpstreamCompleted: "推送完成，并已将 upstream 设置为 {remote}/{branch}。",
    openFolderFirst: "运行个人 Git 流程前，请先打开文件夹或工作区。",
    chooseRepositoryFolder: "选择仓库文件夹",
    upstreamBranchTitle: "Upstream 分支",
    upstreamBranchPrompt: "未检测到 upstream。请输入要同步的分支引用。",
    upstreamRequired: "Upstream 分支必填",
    chooseSyncStrategy: "选择同步策略",
    strategyRebase: "Rebase",
    strategyRebaseDescription: "通过 rebase 保持提交历史线性",
    strategyMerge: "Merge",
    strategyMergeDescription: "需要时创建 merge commit",
    publicVersionTitle: "本机块公共版本",
    publicVersionMissingPrompt: "HEAD 中没有这个文件。请输入 Git 应该提交的公共版本。",
    publicVersionInferPrompt: "无法从 HEAD 推断公共版本。请编辑 Git 应该提交的文本。",
    noLocalBlocksFound: "没有找到本机块{suffix}。",
    activeFileSuffix: "（当前文件）",
    validateBlockIdRequired: "本机块 ID 必填",
    validateBlockIdChars: "只能使用字母、数字、点、下划线或短横线",
    gitCommandFailed: "Git 命令失败：{message}",
    commandFailed: "{name} 失败：{message}"
  };

  type MessageKey = keyof typeof englishMessages;
  const key = template as MessageKey;
  const messages = isChineseLocale ? chineseMessages : englishMessages;
  const message = messages[key] ?? englishMessages[key] ?? template;
  return message.replace(/\{(\w+)\}/g, (match: string, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

class LocalBlocksTreeDataProvider implements vscode.TreeDataProvider<LocalBlockTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<LocalBlockTreeNode | undefined | null | void>();

  readonly onDidChangeTreeData: vscode.Event<LocalBlockTreeNode | undefined | null | void> =
    this.changeEmitter.event;

  refresh(): void {
    this.changeEmitter.fire();
  }

  async getChildren(element?: LocalBlockTreeNode): Promise<LocalBlockTreeNode[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [];
    }

    if (!element) {
      const repositories = await this.getRepositoriesWithBlocks();
      if (folders.length === 1) {
        return repositories.length > 0 ? this.getFileNodes(repositories[0].repoPath, repositories[0].state) : [];
      }

      return repositories.map(({ repoPath, state }) => ({
        kind: "repository",
        repoPath,
        blockCount: state.blocks.length
      }));
    }

    if (element.kind === "repository") {
      const state = await tryReadLocalBlockState(element.repoPath);
      return state ? this.getFileNodes(element.repoPath, state) : [];
    }

    if (element.kind === "file" && element.file) {
      const state = await tryReadLocalBlockState(element.repoPath);
      if (!state) {
        return [];
      }

      const blocks = state.blocks.filter((block) => block.file === element.file);
      return Promise.all(
        blocks.map(async (block) => ({
          kind: "block" as const,
          repoPath: element.repoPath,
          file: block.file,
          block,
          status: await getLocalBlockStatus(element.repoPath, block)
        }))
      );
    }

    return [];
  }

  getTreeItem(element: LocalBlockTreeNode): vscode.TreeItem {
    if (element.kind === "repository") {
      const item = new vscode.TreeItem(path.basename(element.repoPath), vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.blockCount ?? 0} block(s)`;
      item.tooltip = element.repoPath;
      item.iconPath = new vscode.ThemeIcon("repo");
      item.contextValue = "localBlockRepo";
      return item;
    }

    if (element.kind === "file") {
      const item = new vscode.TreeItem(element.file ?? "", vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.blockCount ?? 0} block(s)`;
      item.tooltip = path.join(element.repoPath, fromPosixPath(element.file ?? ""));
      item.resourceUri = vscode.Uri.file(path.join(element.repoPath, fromPosixPath(element.file ?? "")));
      item.contextValue = "localBlockFile";
      return item;
    }

    const block = element.block;
    const item = new vscode.TreeItem(block?.id ?? "local block", vscode.TreeItemCollapsibleState.None);
    item.description = getLocalBlockStatusLabel(element.status);
    item.tooltip = block
      ? `${block.file}#${block.id}\n${localizeText("Status", "状态")}: ${getLocalBlockStatusLabel(element.status)}\n${localizeText("Updated", "更新时间")}: ${block.updatedAt}`
      : undefined;
    item.iconPath = getLocalBlockStatusIcon(element.status);
    item.contextValue = "localBlock";
    item.command = {
      command: "personalGitProcess.revealLocalBlock",
      title: t("revealLocalBlock"),
      arguments: [element]
    };
    return item;
  }

  private async getRepositoriesWithBlocks(): Promise<Array<{ repoPath: string; state: LocalBlockState }>> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const repositories: Array<{ repoPath: string; state: LocalBlockState }> = [];

    for (const folder of folders) {
      const state = await tryReadLocalBlockState(folder.uri.fsPath);
      if (state && state.blocks.length > 0) {
        repositories.push({ repoPath: folder.uri.fsPath, state });
      }
    }

    return repositories;
  }

  private getFileNodes(repoPath: string, state: LocalBlockState): LocalBlockTreeNode[] {
    const counts = new Map<string, number>();
    for (const block of state.blocks) {
      counts.set(block.file, (counts.get(block.file) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, blockCount]) => ({
        kind: "file",
        repoPath,
        file,
        blockCount
      }));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(git-branch) Personal Git";
  statusBar.tooltip = t("statusBarTooltip");
  statusBar.command = "personalGitProcess.syncWorkspace";
  statusBar.show();

  localBlocksProvider = new LocalBlocksTreeDataProvider();
  const localBlocksTree = vscode.window.createTreeView("personalGitProcess.localBlocks", {
    treeDataProvider: localBlocksProvider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    output,
    statusBar,
    localBlocksTree,
    vscode.commands.registerCommand("personalGitProcess.syncWorkspace", () =>
      runCommand(t("commandSyncWorkspace"), syncWorkspace)
    ),
    vscode.commands.registerCommand("personalGitProcess.safePush", () => runCommand(t("commandSafePush"), safePush)),
    vscode.commands.registerCommand("personalGitProcess.protectSelection", () =>
      runCommand(t("commandProtectSelection"), protectSelectionAsLocalBlock)
    ),
    vscode.commands.registerCommand("personalGitProcess.applyLocalBlocks", () =>
      runCommand(t("commandApplyLocalBlocks"), applyLocalBlocksCommand)
    ),
    vscode.commands.registerCommand("personalGitProcess.showPublicVersion", () =>
      runCommand(t("commandShowPublicVersion"), showPublicVersionCommand)
    ),
    vscode.commands.registerCommand("personalGitProcess.safeSyncLocalBlocks", () =>
      runCommand(t("commandSafeSyncLocalBlocks"), safeSyncWithLocalBlocks)
    ),
    vscode.commands.registerCommand("personalGitProcess.installLocalBlockFilter", () =>
      runCommand(t("commandInstallLocalBlockFilter"), installLocalBlockFilterCommand)
    ),
    vscode.commands.registerCommand("personalGitProcess.installPreCommitGuard", () =>
      runCommand(t("commandInstallPreCommitGuard"), installPreCommitGuardCommand)
    ),
    vscode.commands.registerCommand("personalGitProcess.refreshLocalBlocks", () => localBlocksProvider?.refresh()),
    vscode.commands.registerCommand("personalGitProcess.revealLocalBlock", (node?: LocalBlockTreeNode) =>
      runCommand(t("commandRevealLocalBlock"), () => revealLocalBlockCommand(node))
    ),
    vscode.commands.registerCommand("personalGitProcess.applyLocalBlock", (node?: LocalBlockTreeNode) =>
      runCommand(t("commandApplyLocalBlock"), () => applySingleLocalBlockCommand(node))
    ),
    vscode.commands.registerCommand("personalGitProcess.showPublicBlock", (node?: LocalBlockTreeNode) =>
      runCommand(t("commandShowPublicBlock"), () => showSinglePublicBlockCommand(node))
    ),
    vscode.commands.registerCommand("personalGitProcess.applyLocalBlockFromEditor", () =>
      runCommand(t("commandApplyCurrentFileLocalBlock"), () => applySingleLocalBlockCommand(undefined, true))
    ),
    vscode.commands.registerCommand("personalGitProcess.showPublicBlockFromEditor", () =>
      runCommand(t("commandShowCurrentFilePublicBlock"), () => showSinglePublicBlockCommand(undefined, true))
    ),
    vscode.commands.registerCommand("personalGitProcess.updateLocalBlockFromSelection", (node?: LocalBlockTreeNode) =>
      runCommand(t("commandUpdateLocalBlockFromSelection"), () => updateLocalBlockFromSelectionCommand(node))
    ),
    vscode.commands.registerCommand("personalGitProcess.deleteLocalBlock", (node?: LocalBlockTreeNode) =>
      runCommand(t("commandDeleteLocalBlock"), () => deleteLocalBlockCommand(node))
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
    vscode.window.showWarningMessage(t("openFileSelectCode"));
    return;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    vscode.window.showWarningMessage(t("selectLocalBlockCode"));
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
    vscode.window.showWarningMessage(t("selectedFileOutsideRepo"));
    return;
  }

  const localText = editor.document.getText(selection);
  const id = await vscode.window.showInputBox({
    title: t("localBlockIdTitle"),
    prompt: t("localBlockIdPrompt"),
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
    vscode.window.showWarningMessage(t("localBlockExists", { file: relativeFile, id: blockId }));
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
  await installLocalBlockFilter(repoPath);
  refreshLocalBlocksView();

  vscode.window.showInformationMessage(t("localBlockSaved", { file: relativeFile, id: block.id }));
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
  refreshLocalBlocksView();

  if (result.conflicts > 0) {
    vscode.window.showWarningMessage(
      t("appliedWithConflicts", { applied: result.applied, conflicts: result.conflicts })
    );
    return;
  }

  vscode.window.showInformationMessage(t("appliedCount", { count: result.applied }));
}

async function showPublicVersionCommand(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(repoPath);
  const result = await restorePublicVersion(repoPath);
  refreshLocalBlocksView();

  if (result.conflicts > 0) {
    vscode.window.showWarningMessage(
      t("restoredWithConflicts", { restored: result.restored, conflicts: result.conflicts })
    );
    return;
  }

  vscode.window.showInformationMessage(t("restoredCount", { count: result.restored }));
}

async function revealLocalBlockCommand(node?: LocalBlockTreeNode): Promise<void> {
  const target = await resolveLocalBlockTarget(node, { title: t("chooseBlockReveal") });
  if (!target) {
    return;
  }

  const filePath = path.join(target.repoPath, fromPosixPath(target.block.file));
  const document = await vscode.workspace.openTextDocument(filePath);
  const editor = await vscode.window.showTextDocument(document);
  const location = findBlockLocation(document.getText(), target.block);

  if (!location) {
    vscode.window.showWarningMessage(
      t("blockNotFoundInFile", { file: target.block.file, id: target.block.id })
    );
    return;
  }

  const range = new vscode.Range(
    document.positionAt(location.index),
    document.positionAt(location.index + location.currentText.length)
  );
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function applySingleLocalBlockCommand(node?: LocalBlockTreeNode, activeFileOnly = false): Promise<void> {
  const target = await resolveLocalBlockTarget(node, {
    title: activeFileOnly ? t("chooseBlockApplyCurrentFile") : t("chooseBlockApply"),
    activeFileOnly,
    preferActiveSelection: activeFileOnly
  });
  if (!target) {
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(target.repoPath);
  const result = await applySingleLocalBlock(target.repoPath, target.block);
  refreshLocalBlocksView();

  if (result === "conflict") {
    vscode.window.showWarningMessage(t("blockNeedsManualHandling", { file: target.block.file, id: target.block.id }));
    return;
  }

  vscode.window.showInformationMessage(
    result === "changed"
      ? t("appliedBlock", { file: target.block.file, id: target.block.id })
      : t("blockAlreadyApplied", { file: target.block.file, id: target.block.id })
  );
}

async function showSinglePublicBlockCommand(node?: LocalBlockTreeNode, activeFileOnly = false): Promise<void> {
  const target = await resolveLocalBlockTarget(node, {
    title: activeFileOnly ? t("chooseBlockShowPublicCurrentFile") : t("chooseBlockShowPublic"),
    activeFileOnly,
    preferActiveSelection: activeFileOnly
  });
  if (!target) {
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(target.repoPath);
  const result = await restoreSinglePublicBlock(target.repoPath, target.block);
  refreshLocalBlocksView();

  if (result === "conflict") {
    vscode.window.showWarningMessage(t("blockNeedsManualHandling", { file: target.block.file, id: target.block.id }));
    return;
  }

  vscode.window.showInformationMessage(
    result === "changed"
      ? t("restoredBlock", { file: target.block.file, id: target.block.id })
      : t("blockAlreadyPublic", { file: target.block.file, id: target.block.id })
  );
}

async function updateLocalBlockFromSelectionCommand(node?: LocalBlockTreeNode): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage(t("openFileSelectNewContent"));
    return;
  }

  if (editor.selection.isEmpty) {
    vscode.window.showWarningMessage(t("selectNewContent"));
    return;
  }

  const target = await resolveLocalBlockTarget(node, {
    title: t("chooseBlockUpdate"),
    activeFileOnly: true,
    preferActiveSelection: true
  });
  if (!target) {
    return;
  }

  const absoluteFile = editor.document.uri.fsPath;
  const relativeFile = toPosixPath(path.relative(target.repoPath, absoluteFile));
  if (relativeFile !== target.block.file) {
    vscode.window.showWarningMessage(
      t("selectionMustBeInside", { file: target.block.file, id: target.block.id })
    );
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(target.repoPath);

  const state = await readLocalBlockState(target.repoPath);
  const block = findStoredBlock(state, target.block);
  if (!block) {
    vscode.window.showWarningMessage(t("blockNoLongerExists", { file: target.block.file, id: target.block.id }));
    refreshLocalBlocksView();
    return;
  }

  const newLocalText = editor.document.getText(editor.selection);
  const documentLines = editor.document.getText().split(/\r?\n/);
  block.localText = newLocalText;
  block.localHash = hashText(newLocalText);
  block.contextBefore = getContextBefore(documentLines, editor.selection.start.line);
  block.contextAfter = getContextAfter(documentLines, editor.selection.end.line);
  block.status = "local";
  block.updatedAt = new Date().toISOString();

  await writeLocalBlockState(target.repoPath, state);
  await installLocalBlockFilter(target.repoPath);
  refreshLocalBlocksView();

  vscode.window.showInformationMessage(t("updatedBlockFromSelection", { file: block.file, id: block.id }));
  log(`Updated local block from selection: ${block.file}#${block.id}`);
}

async function deleteLocalBlockCommand(node?: LocalBlockTreeNode): Promise<void> {
  const target = await resolveLocalBlockTarget(node, { title: t("chooseBlockDelete") });
  if (!target) {
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    t("deleteBlockQuestion", { file: target.block.file, id: target.block.id }),
    { modal: true },
    t("actionRestorePublicAndDelete"),
    t("actionKeepFileContentAndDelete")
  );

  if (!choice) {
    log("Delete local block cancelled.");
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(target.repoPath);

  if (choice === t("actionRestorePublicAndDelete")) {
    const restoreResult = await restoreSinglePublicBlock(target.repoPath, target.block);
    if (restoreResult === "conflict") {
      vscode.window.showWarningMessage(
        t("deleteStopped", { file: target.block.file, id: target.block.id })
      );
      refreshLocalBlocksView();
      return;
    }
  }

  const state = await readLocalBlockState(target.repoPath);
  const before = state.blocks.length;
  state.blocks = state.blocks.filter(
    (block) => !(block.file === target.block.file && block.id === target.block.id)
  );

  if (state.blocks.length === before) {
    vscode.window.showWarningMessage(t("blockNoLongerExists", { file: target.block.file, id: target.block.id }));
    refreshLocalBlocksView();
    return;
  }

  await writeLocalBlockState(target.repoPath, state);
  await installLocalBlockFilter(target.repoPath);
  refreshLocalBlocksView();

  vscode.window.showInformationMessage(t("deletedBlock", { file: target.block.file, id: target.block.id }));
  log(`Deleted local block: ${target.block.file}#${target.block.id}`);
}

async function installPreCommitGuardCommand(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(repoPath);
  await installPreCommitGuard(repoPath);
  vscode.window.showInformationMessage(t("preCommitGuardInstalled"));
}

async function installLocalBlockFilterCommand(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  ensureOutputVisible();
  await ensureGitRepository(repoPath);
  await installLocalBlockFilter(repoPath);
  refreshLocalBlocksView();
  vscode.window.showInformationMessage(t("filterInstalled"));
}

async function safeSyncWithLocalBlocks(): Promise<void> {
  const repoPath = await pickRepository();
  if (!repoPath) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t("progressSafeSync"),
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: t("progressCheckingRepo") });

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

      progress.report({ message: t("progressRestoringPublic") });
      const restoreResult = await restorePublicVersion(repoPath);
      if (restoreResult.conflicts > 0) {
        vscode.window.showWarningMessage(
          t("safeSyncRestoreStopped")
        );
        return;
      }

      const hasChanges = await hasWorkingTreeChanges(repoPath);
      let stashCreated = false;
      let stashRef = "";

      if (hasChanges) {
        const choice = await vscode.window.showWarningMessage(
          t("localChangesAfterPublic"),
          { modal: true },
          t("actionStashAndContinue"),
          t("actionCancel")
        );

        if (choice !== t("actionStashAndContinue")) {
          log("Safe sync cancelled because local changes were not stashed.");
          await applyLocalBlocks(repoPath);
          return;
        }

        stashRef = "stash@{0}";
        await git(repoPath, ["stash", "push", "-u", "-m", buildStashMessage()]);
        stashCreated = true;
        log(`Created stash ${stashRef}.`);
      }

      progress.report({ message: t("progressFetching") });
      await git(repoPath, ["fetch", "--all", "--prune"]);

      progress.report({ message: t("progressRunningStrategy", { strategy, upstream }) });
      if (strategy === "rebase") {
        await git(repoPath, ["rebase", upstream]);
      } else {
        await git(repoPath, ["merge", "--no-edit", upstream]);
      }

      if (stashCreated) {
        progress.report({ message: t("progressReapplyingStash") });
        try {
          await git(repoPath, ["stash", "apply", stashRef]);
          await git(repoPath, ["stash", "drop", stashRef]);
          log(`Dropped stash ${stashRef} after successful apply.`);
        } catch (error) {
          log(`Stash apply failed. Keeping ${stashRef} for manual recovery.`);
          throw error;
        }
      }

      progress.report({ message: t("progressApplyingBlocks") });
      const applyResult = await applyLocalBlocks(repoPath);
      refreshLocalBlocksView();
      if (applyResult.conflicts > 0) {
        vscode.window.showWarningMessage(
          t("syncCompletedWithConflicts", { conflicts: applyResult.conflicts })
        );
        return;
      }

      vscode.window.showInformationMessage(t("safeSyncCompleted", { branch }));
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
      title: t("progressSync"),
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: t("progressCheckingRepo") });

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
          t("localChangesStashQuestion"),
          { modal: true },
          t("actionStashAndContinue"),
          t("actionCancel")
        );

        if (choice !== t("actionStashAndContinue")) {
          log("Sync cancelled because local changes were not stashed.");
          return;
        }

        stashRef = "stash@{0}";
        await git(repoPath, ["stash", "push", "-u", "-m", buildStashMessage()]);
        stashCreated = true;
        log(`Created stash ${stashRef}.`);
      }

      progress.report({ message: t("progressFetching") });
      await git(repoPath, ["fetch", "--all", "--prune"]);

      progress.report({ message: t("progressRunningStrategy", { strategy, upstream }) });
      if (strategy === "rebase") {
        await git(repoPath, ["rebase", upstream]);
      } else {
        await git(repoPath, ["merge", "--no-edit", upstream]);
      }

      if (stashCreated) {
        progress.report({ message: t("progressReapplyingStash") });
        try {
          await git(repoPath, ["stash", "apply", stashRef]);
          await git(repoPath, ["stash", "drop", stashRef]);
          log(`Dropped stash ${stashRef} after successful apply.`);
        } catch (error) {
          log(`Stash apply failed. Keeping ${stashRef} for manual recovery.`);
          throw error;
        }
      }

      vscode.window.showInformationMessage(t("syncCompleted", { branch }));
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
      title: t("progressSafePush"),
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: t("progressCheckingRepo") });

      ensureOutputVisible();
      log(`Safe push start: ${repoPath}`);

      await ensureGitRepository(repoPath);
      const branch = await getCurrentBranch(repoPath);
      const dirty = await hasWorkingTreeChanges(repoPath);

      if (dirty) {
        vscode.window.showWarningMessage(t("pushBlockedDirty"));
        log("Push blocked because working tree is dirty.");
        return;
      }

      const upstream = await getUpstreamBranch(repoPath);
      progress.report({ message: t("progressFetching") });
      await git(repoPath, ["fetch", "--all", "--prune"]);

      if (upstream) {
        const { behind, ahead } = await getAheadBehind(repoPath, upstream);
        log(`Ahead/behind against ${upstream}: ahead=${ahead}, behind=${behind}`);

        if (behind > 0) {
          vscode.window.showWarningMessage(
            t("pushBlockedBehind", { upstream, behind })
          );
          return;
        }

        const proceed = await vscode.window.showInformationMessage(
          ahead > 0
            ? t("pushAheadQuestion", { ahead, branch, upstream })
            : t("pushNoAheadQuestion", { upstream }),
          { modal: true },
          t("actionPush"),
          t("actionCancel")
        );

        if (proceed !== t("actionPush")) {
          log("Push cancelled by user.");
          return;
        }

        progress.report({ message: localizeText("Pushing to upstream", "正在推送到 upstream") });
        await git(repoPath, ["push"]);
        vscode.window.showInformationMessage(t("pushCompleted", { branch }));
        log(`Push finished successfully on ${branch}.`);
        return;
      }

      const targetRemote = await vscode.window.showInputBox({
        title: t("setUpstreamRemoteTitle"),
        prompt: t("setUpstreamRemotePrompt"),
        value: "origin",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : t("remoteRequired"))
      });

      if (!targetRemote) {
        log("Push cancelled because no remote was provided.");
        return;
      }

      const proceed = await vscode.window.showInformationMessage(
        t("pushSetUpstreamQuestion", { branch, remote: targetRemote }),
        { modal: true },
        t("actionPush"),
        t("actionCancel")
      );

      if (proceed !== t("actionPush")) {
        log("Initial push cancelled by user.");
        return;
      }

      progress.report({ message: localizeText("Pushing and setting upstream", "正在推送并设置 upstream") });
      await git(repoPath, ["push", "--set-upstream", targetRemote, branch]);
      vscode.window.showInformationMessage(t("pushUpstreamCompleted", { remote: targetRemote, branch }));
      log(`Push finished successfully on ${branch} with upstream ${targetRemote}/${branch}.`);
    }
  );
}

async function pickRepository(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage(t("openFolderFirst"));
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
      title: t("chooseRepositoryFolder"),
      ignoreFocusOut: true
    }
  );

  return selected?.path;
}

async function pickRepositoryForFile(filePath: string): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage(t("openFolderFirst"));
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
        title: t("chooseRepositoryFolder"),
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
    title: t("upstreamBranchTitle"),
    prompt: t("upstreamBranchPrompt"),
    value: `origin/${branch}`,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? undefined : t("upstreamRequired"))
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
        label: t("strategyRebase"),
        description: t("strategyRebaseDescription"),
        value: "rebase" as const
      },
      {
        label: t("strategyMerge"),
        description: t("strategyMergeDescription"),
        value: "merge" as const
      }
    ],
    {
      title: t("chooseSyncStrategy"),
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

async function applySingleLocalBlock(repoPath: string, targetBlock: LocalBlock): Promise<SingleBlockActionResult> {
  return setSingleBlockVersion(repoPath, targetBlock, "local");
}

async function restoreSinglePublicBlock(repoPath: string, targetBlock: LocalBlock): Promise<SingleBlockActionResult> {
  return setSingleBlockVersion(repoPath, targetBlock, "public");
}

async function setSingleBlockVersion(
  repoPath: string,
  targetBlock: LocalBlock,
  version: "local" | "public"
): Promise<SingleBlockActionResult> {
  const state = await readLocalBlockState(repoPath);
  const block = findStoredBlock(state, targetBlock);
  if (!block) {
    log(`Local block not found: ${targetBlock.file}#${targetBlock.id}`);
    return "conflict";
  }

  const filePath = path.join(repoPath, fromPosixPath(block.file));
  let text: string;

  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    block.status = "conflict";
    block.updatedAt = new Date().toISOString();
    await writeLocalBlockState(repoPath, state);
    log(`Local block conflict ${block.file}#${block.id}: file cannot be read (${String(error)}).`);
    return "conflict";
  }

  const location = findBlockLocation(text, block);
  if (!location) {
    block.status = "conflict";
    block.updatedAt = new Date().toISOString();
    await writeLocalBlockState(repoPath, state);
    log(`Local block conflict ${block.file}#${block.id}: base/local text not found.`);
    return "conflict";
  }

  const nextText = version === "local" ? block.localText : block.baseText;
  const nextStatus: BlockStatus = version === "local" ? "local" : "public";
  const alreadyDesired = location.currentText === nextText;
  if (!alreadyDesired) {
    const updated = replaceAt(text, location.index, location.currentText, nextText);
    await fs.writeFile(filePath, updated, "utf8");
  }

  block.status = nextStatus;
  block.updatedAt = new Date().toISOString();
  await writeLocalBlockState(repoPath, state);
  log(`${version === "local" ? "Applied local block" : "Restored public version"}: ${block.file}#${block.id}`);

  return alreadyDesired ? "unchanged" : "changed";
}

function findStoredBlock(state: LocalBlockState, targetBlock: LocalBlock): LocalBlock | undefined {
  return state.blocks.find((block) => block.file === targetBlock.file && block.id === targetBlock.id);
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
      title: t("publicVersionTitle"),
      prompt: t("publicVersionMissingPrompt"),
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
    title: t("publicVersionTitle"),
    prompt: t("publicVersionInferPrompt"),
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

  const before = workspaceContent.slice(0, selectionOffset);
  const after = workspaceContent.slice(selectionOffset + localText.length);
  const beforeAnchors = getAnchors(before, "end");
  const afterAnchors = getAnchors(after, "start");

  for (const beforeAnchor of beforeAnchors) {
    for (const afterAnchor of afterAnchors) {
      const beforeIndex = headContent.indexOf(beforeAnchor);
      if (beforeIndex < 0) {
        continue;
      }

      const start = beforeIndex + beforeAnchor.length;
      const afterIndex = headContent.indexOf(afterAnchor, start);
      if (afterIndex >= start) {
        return { start, end: afterIndex };
      }
    }
  }

  for (const beforeAnchor of beforeAnchors) {
    const beforeIndex = headContent.lastIndexOf(beforeAnchor);
    if (beforeIndex >= 0) {
      return { start: beforeIndex + beforeAnchor.length, end: headContent.length };
    }
  }

  for (const afterAnchor of afterAnchors) {
    const afterIndex = headContent.indexOf(afterAnchor);
    if (afterIndex >= 0) {
      return { start: 0, end: afterIndex };
    }
  }

  if (headContent.includes(localText)) {
    const start = headContent.indexOf(localText);
    return { start, end: start + localText.length };
  }

  return undefined;
}

function getAnchors(text: string, side: "start" | "end"): string[] {
  const anchors = [getAnchor(text, side)];
  const compactAnchor = getCompactLineAnchor(text, side);
  if (compactAnchor) {
    anchors.push(compactAnchor);
  }

  return [...new Set(anchors.filter((anchor) => anchor.length > 0))];
}

function getAnchor(text: string, side: "start" | "end"): string {
  if (side === "start") {
    return text.slice(0, ANCHOR_CHARS);
  }

  return text.slice(Math.max(0, text.length - ANCHOR_CHARS));
}

function getCompactLineAnchor(text: string, side: "start" | "end"): string {
  const lines = text.split(/\r?\n/);

  if (side === "start") {
    const selected = lines.filter((line) => line.trim().length > 0).slice(0, CONTEXT_LINES);
    return selected.join("\n");
  }

  const selected = lines.filter((line) => line.trim().length > 0).slice(-CONTEXT_LINES);
  return selected.join("\n");
}

async function installLocalBlockFilter(repoPath: string): Promise<void> {
  const state = await readLocalBlockState(repoPath);
  const files = [...new Set(state.blocks.map((block) => block.file))].sort();

  await writeFilterScript(repoPath);
  await configureFilter(repoPath);
  await updateInfoAttributes(repoPath, files);

  log(`Installed local block Git filter for ${files.length} file(s).`);
}

async function writeFilterScript(repoPath: string): Promise<void> {
  const dirPath = await getLocalBlocksDir(repoPath);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(path.join(dirPath, FILTER_SCRIPT_FILE), buildFilterScript(), "utf8");
}

async function configureFilter(repoPath: string): Promise<void> {
  const scriptPath = path.join(await getLocalBlocksDir(repoPath), FILTER_SCRIPT_FILE);
  const command = `node ${quoteForGitConfig(scriptPath)} %f`;

  await git(repoPath, ["config", `filter.${FILTER_NAME}.clean`, command]);
  await git(repoPath, ["config", `filter.${FILTER_NAME}.smudge`, command]);
  await git(repoPath, ["config", `filter.${FILTER_NAME}.required`, "false"]);
}

async function updateInfoAttributes(repoPath: string, files: string[]): Promise<void> {
  const gitDir = await getGitDir(repoPath);
  const infoDir = path.join(gitDir, INFO_DIR);
  await fs.mkdir(infoDir, { recursive: true });

  const attributesPath = path.join(infoDir, ATTRIBUTES_FILE);
  let existing = "";
  try {
    existing = await fs.readFile(attributesPath, "utf8");
  } catch {
    // A repository may not have .git/info/attributes yet.
  }

  const block = [
    ATTRIBUTES_MARKER_BEGIN,
    ...files.map((file) => `${escapeAttributePattern(file)} filter=${FILTER_NAME}`),
    ATTRIBUTES_MARKER_END
  ].join("\n");

  const markerPattern = new RegExp(
    `${escapeRegExp(ATTRIBUTES_MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(ATTRIBUTES_MARKER_END)}\\r?\\n?`,
    "m"
  );

  const cleaned = existing.replace(markerPattern, "").trimEnd();
  const next = cleaned.length > 0 ? `${cleaned}\n\n${block}\n` : `${block}\n`;
  await fs.writeFile(attributesPath, next, "utf8");
}

function buildFilterScript(): string {
  return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function loadState() {
  const statePath = path.join(__dirname, 'state.json');
  if (!fs.existsSync(statePath)) {
    return { blocks: [] };
  }

  try {
    const raw = fs.readFileSync(statePath, 'utf8').replace(/^\\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.blocks) ? parsed : { blocks: [] };
  } catch (_) {
    return { blocks: [] };
  }
}

function normalizeFile(value) {
  return String(value || '').replace(/\\\\/g, '/');
}

function transform(text, file) {
  const state = loadState();
  const target = normalizeFile(file);

  for (const block of state.blocks) {
    if (!block || normalizeFile(block.file) !== target) {
      continue;
    }

    if (!block.localText || block.localText === block.baseText) {
      continue;
    }

    if (text.includes(block.localText)) {
      text = text.split(block.localText).join(block.baseText || '');
    }
  }

  return text;
}

const input = readStdin();
const output = transform(input, process.argv[2]);
process.stdout.write(output);
`;
}


function quoteForGitConfig(value: string): string {
  return `"${value.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

function escapeAttributePattern(value: string): string {
  const normalized = toPosixPath(value);
  if (/[\s#"]/.test(normalized)) {
    return `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const raw = (await fs.readFile(statePath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as LocalBlockState;
    return {
      version: parsed.version || STATE_VERSION,
      blocks: Array.isArray(parsed.blocks) ? parsed.blocks : []
    };
  } catch {
    return { version: STATE_VERSION, blocks: [] };
  }
}

async function tryReadLocalBlockState(repoPath: string): Promise<LocalBlockState | undefined> {
  try {
    await ensureGitRepository(repoPath);
    const statePath = await getStatePath(repoPath);
    try {
      await fs.access(statePath);
    } catch {
      return undefined;
    }

    return await readLocalBlockState(repoPath);
  } catch {
    return undefined;
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

async function getLocalBlockStatus(repoPath: string, block: LocalBlock): Promise<LocalBlockTreeStatus> {
  const filePath = path.join(repoPath, fromPosixPath(block.file));

  try {
    const text = await fs.readFile(filePath, "utf8");
    const location = findBlockLocation(text, block);
    if (!location) {
      return "conflict";
    }

    return location.matchedBy === "local" ? "local" : "public";
  } catch {
    return "missing";
  }
}

function getLocalBlockStatusLabel(status: LocalBlockTreeStatus | undefined): string {
  switch (status) {
    case "local":
      return localizeText("local", "本机");
    case "public":
      return localizeText("public", "公共");
    case "missing":
      return localizeText("missing", "缺失");
    case "conflict":
      return localizeText("conflict", "冲突");
    default:
      return localizeText("unknown", "未知");
  }
}

function getLocalBlockStatusIcon(status: LocalBlockTreeStatus | undefined): vscode.ThemeIcon {
  switch (status) {
    case "local":
      return new vscode.ThemeIcon("home");
    case "public":
      return new vscode.ThemeIcon("globe");
    case "missing":
      return new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("problemsErrorIcon.foreground"));
    case "conflict":
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
    default:
      return new vscode.ThemeIcon("question");
  }
}

async function resolveLocalBlockTarget(
  node: LocalBlockTreeNode | undefined,
  options: { title: string; activeFileOnly?: boolean; preferActiveSelection?: boolean }
): Promise<LocalBlockTarget | undefined> {
  if (node?.kind === "block" && node.block) {
    return { repoPath: node.repoPath, block: node.block };
  }

  const items = await listLocalBlockQuickPickItems(options.activeFileOnly === true);
  if (items.length === 0) {
    const suffix = options.activeFileOnly ? t("activeFileSuffix") : "";
    vscode.window.showWarningMessage(t("noLocalBlocksFound", { suffix }));
    return undefined;
  }

  const selectionTarget = options.preferActiveSelection ? getTargetMatchingActiveSelection(items) : undefined;
  if (selectionTarget) {
    return selectionTarget;
  }

  if (items.length === 1 && options.activeFileOnly === true) {
    return items[0].target;
  }

  const selected = await vscode.window.showQuickPick(items, {
    title: options.title,
    ignoreFocusOut: true
  });

  return selected?.target;
}

function getTargetMatchingActiveSelection(items: LocalBlockQuickPickItem[]): LocalBlockTarget | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }

  const selectedText = editor.document.getText(editor.selection);
  const matches = items.filter(
    (item) => item.target.block.localText === selectedText || item.target.block.baseText === selectedText
  );

  return matches.length === 1 ? matches[0].target : undefined;
}

async function listLocalBlockQuickPickItems(activeFileOnly: boolean): Promise<LocalBlockQuickPickItem[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const items: LocalBlockQuickPickItem[] = [];

  for (const folder of folders) {
    const repoPath = folder.uri.fsPath;
    const state = await tryReadLocalBlockState(repoPath);
    if (!state) {
      continue;
    }

    let activeRelativeFile: string | undefined;
    if (activeFile && isPathInside(activeFile, repoPath)) {
      activeRelativeFile = toPosixPath(path.relative(repoPath, activeFile));
    }

    for (const block of state.blocks) {
      if (activeFileOnly && block.file !== activeRelativeFile) {
        continue;
      }

      const status = await getLocalBlockStatus(repoPath, block);
      items.push({
        label: block.id,
        description: block.file,
        detail: `${path.basename(repoPath)} - ${getLocalBlockStatusLabel(status)}`,
        target: { repoPath, block }
      });
    }
  }

  return items.sort((left, right) => {
    const fileCompare = (left.description ?? "").localeCompare(right.description ?? "");
    return fileCompare === 0 ? left.label.localeCompare(right.label) : fileCompare;
  });
}

function refreshLocalBlocksView(): void {
  localBlocksProvider?.refresh();
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
    return t("validateBlockIdRequired");
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(value.trim())) {
    return t("validateBlockIdChars");
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
          vscode.window.showErrorMessage(t("gitCommandFailed", { message }));
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
    vscode.window.showErrorMessage(t("commandFailed", { name, message }));
  }
}

