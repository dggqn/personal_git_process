# Personal Git Process

[中文](#中文) | [English](#english)

## 中文

`Personal Git Process` 是一个面向个人工作流的 VS Code Git 辅助插件。它的目标不是替代 Git，而是把常用的同步、推送、本机私有代码保护流程做成更安全、更明确的命令。

### 适合什么场景

- 你经常需要先同步远端，再继续本地开发。
- 你想在 push 前确认当前分支没有落后远端。
- 你有一些只想保留在本机的代码或配置，例如本地接口地址、本机路径、调试开关。
- 你希望编辑器里能保留本机版本，但 Git 提交时仍然使用公共版本。

### 核心功能

#### 安全同步

命令：`Personal Git Process: Sync Workspace`

- 自动检查当前仓库和分支。
- 拉取远端更新。
- 支持选择 `rebase` 或 `merge`。
- 如果工作区有未提交内容，会先询问是否创建 stash。

#### 安全推送

命令：`Personal Git Process: Safe Push`

- 如果工作区有未提交改动，阻止 push。
- 如果当前分支落后 upstream，阻止 push。
- 首次推送分支时可以设置 upstream。

#### 本机块 Local Blocks

Local Block 是一段“只保留在本机”的代码。插件会保存两份内容：

- `localText`：你在编辑器里想长期保留的本机版本。
- `baseText`：Git 应该看到并提交的公共版本。

命令：`Personal Git Process: Protect Selection as Local Block`

使用方式：

1. 打开一个 Git 已跟踪文件。
2. 把某几行改成本机版本。
3. 选中这几行。
4. 右键选区，点击 `Personal Git Process` → `Protect Selection as Local Block`。也可以用命令面板执行同名命令。
5. 输入块名，例如 `local-api-url`。
6. 插件会把本机块保存到 `.git/local-blocks/state.json`，并安装本地 Git filter。

启用 filter 后，工作区可以显示本机版本，但 Git clean/filter 会把它转换回公共版本用于 diff、status 和 commit。

#### 侧边栏管理界面

安装新版后，VS Code 左侧活动栏会出现 `Personal Git` 图标。打开后可以看到 `Local Blocks` 列表：

- 文件夹节点：按仓库和文件归类本机块。
- 本机块节点：显示块名和状态，`local` 表示编辑器里是本机版本，`public` 表示当前显示公共版本，`conflict` / `missing` 表示需要手动检查。
- 点击本机块：跳转到对应代码位置。
- 右键本机块：可以单独应用本机版本、显示公共版本、用当前选区更新本机块、删除本机块。
- 右上角刷新按钮：重新扫描 `.git/local-blocks/state.json` 和当前文件内容。

#### 编辑器右键二级菜单

在代码编辑器里右键，会出现 `Personal Git Process` 二级菜单：

- `Protect Selection as Local Block`：把当前选区保护为本机块。
- `Update Local Block From Selection`：用当前选区更新已有本机块。
- `Apply Local Version for Current File Block`：把当前文件里的某个本机块切回本机版本。
- `Show Public Version for Current File Block`：把当前文件里的某个本机块切回公共版本，也就是你说的“远程版本/可提交版本”。
- `Apply Local Blocks` / `Show Public Version`：对整个仓库的所有本机块批量切换。

#### 本机块切换命令

- `Personal Git Process: Apply Local Blocks`
  - 把公共版本替换成本机版本，方便继续开发。
- `Personal Git Process: Show Public Version`
  - 把本机版本替换成公共版本，方便肉眼检查提交内容。
- `Personal Git Process: Safe Sync With Local Blocks`
  - 同步远端前先显示公共版本，同步后再恢复本机块。
- `Personal Git Process: Install Local Block Git Filter`
  - 重新安装 `.git/config`、`.git/info/attributes`、`.git/local-blocks/filter.cjs`。
- `Personal Git Process: Install Local Block Pre-Commit Guard`
  - 安装本地 `pre-commit` 钩子，防止本机私有内容被 staged 后误提交。
- `Personal Git Process: Update Local Block From Selection`
  - 选中新本机代码后，更新已有本机块的 `localText`。
- `Personal Git Process: Delete Local Block`
  - 删除已有本机块，可选择先恢复公共版本再删除，或保留当前文件内容直接删除记录。
- `Personal Git Process: Open Output`
  - 打开插件日志面板。

### Local Blocks 数据存在哪里

所有本机块数据都放在当前仓库的 `.git` 目录里：

```text
.git/local-blocks/state.json
.git/local-blocks/filter.cjs
.git/info/attributes
.git/config
.git/hooks/pre-commit
```

这些文件不会被提交到远端。换一份 clone 后，需要重新创建或导入本机块。

### 推荐工作流

第一次保护本机代码：

```text
修改代码为本机版本
选中本机代码
右键选区，执行 Personal Git Process -> Protect Selection as Local Block
执行 Install Local Block Pre-Commit Guard
```

日常开发：

```text
编辑器里保持本机版本
Git filter 让 Git 看到公共版本
需要查看公共版本时执行 Show Public Version
需要恢复本机版本时执行 Apply Local Blocks
需要管理单个块时打开左侧 Personal Git 面板
```

同步远端：

```text
执行 Safe Sync With Local Blocks
```

发布插件新版本：

```powershell
npm run compile
git add .
git commit -m "Release 0.0.x"
git push origin main
git tag v0.0.x
git push origin v0.0.x
```

推送 tag 后，GitHub Actions 会自动发布到 VS Code Marketplace。

### 当前限制

- 本机块使用文本替换，不做 AST 语法分析。
- 当前更适合保护连续选中的一段代码。
- 如果相同文本在同一文件中出现多次，可能匹配到第一个。
- 如果远端也修改了同一段公共代码，插件会标记冲突，需要手动处理。
- 如果你保护后又改了本机块内容，需要重新保护或更新本机块记录。
- 菜单、命令和主要弹窗支持中英文；VS Code 语言为 `zh-cn` 时显示中文，其余语言显示英文。

### 开发

```bash
npm install
npm run compile
```

在 VS Code 中按 `F5` 启动 Extension Development Host。

### 打包

```bash
npm run compile
npm run package
```

---

## English

`Personal Git Process` is a VS Code Git helper for personal workflows. It does not replace Git. Instead, it turns common sync, push, and local-only code protection tasks into explicit and safer commands.

### Use Cases

- You often sync remote changes before continuing local development.
- You want to block unsafe pushes when the branch is behind upstream.
- You have machine-only code or config, such as local API URLs, machine paths, or debug flags.
- You want the editor to keep the local version while Git commits the public version.

### Core Features

#### Safe Sync

Command: `Personal Git Process: Sync Workspace`

- Checks the current repository and branch.
- Fetches remote updates.
- Lets you choose `rebase` or `merge`.
- Prompts before stashing when the working tree is dirty.

#### Safe Push

Command: `Personal Git Process: Safe Push`

- Blocks push when the working tree has uncommitted changes.
- Blocks push when the current branch is behind upstream.
- Helps set upstream on first push.

#### Local Blocks

A Local Block is a piece of code that should stay only on your machine. The extension stores two versions:

- `localText`: the local version you want to keep in the editor.
- `baseText`: the public version Git should see and commit.

Command: `Personal Git Process: Protect Selection as Local Block`

Workflow:

1. Open a Git-tracked file.
2. Change some lines to your local version.
3. Select those lines.
4. Right-click the selection and choose `Personal Git Process` -> `Protect Selection as Local Block`. You can also run the same command from the command palette.
5. Enter a block id, for example `local-api-url`.
6. The extension saves the block to `.git/local-blocks/state.json` and installs a local Git filter.

After the filter is enabled, your working tree can show the local version, while Git clean/filter converts it back to the public version for diff, status, and commit operations.

#### Sidebar UI

After installing the new version, VS Code shows a `Personal Git` icon in the Activity Bar. Open it to manage `Local Blocks`:

- Folder nodes group blocks by repository and file.
- Block nodes show the block id and status: `local` means the editor contains local text, `public` means the file currently shows public text, and `conflict` / `missing` means manual review is needed.
- Click a block to reveal it in the editor.
- Right-click a block to apply the local version, show the public version, update it from the current selection, or delete it.
- Use the refresh button to rescan `.git/local-blocks/state.json` and current file content.

#### Editor Context Submenu

Right-click in the editor and open the `Personal Git Process` submenu:

- `Protect Selection as Local Block`: protects the current selection as a local block.
- `Update Local Block From Selection`: updates an existing local block from the current selection.
- `Apply Local Version for Current File Block`: switches one block in the current file back to the local version.
- `Show Public Version for Current File Block`: switches one block in the current file back to the public version, meaning the remote/committable version.
- `Apply Local Blocks` / `Show Public Version`: batch-switches all local blocks in the repository.

#### Local Block Commands

- `Personal Git Process: Apply Local Blocks`
  - Replaces public text with saved local-only text.
- `Personal Git Process: Show Public Version`
  - Replaces local-only text with the public version for visual review.
- `Personal Git Process: Safe Sync With Local Blocks`
  - Shows public versions before syncing, then reapplies local blocks.
- `Personal Git Process: Install Local Block Git Filter`
  - Reinstalls `.git/config`, `.git/info/attributes`, and `.git/local-blocks/filter.cjs` wiring.
- `Personal Git Process: Install Local Block Pre-Commit Guard`
  - Installs a local `pre-commit` hook to block staged local-only text.
- `Personal Git Process: Update Local Block From Selection`
  - Updates an existing block's `localText` from the current selection.
- `Personal Git Process: Delete Local Block`
  - Deletes a saved block, with an option to restore public text first or keep the current file content.
- `Personal Git Process: Open Output`
  - Opens the extension output channel.

### Where Local Data Lives

Local block data is stored inside the current repository's `.git` directory:

```text
.git/local-blocks/state.json
.git/local-blocks/filter.cjs
.git/info/attributes
.git/config
.git/hooks/pre-commit
```

These files are not pushed to the remote. If you clone the repository again, you need to recreate or import your local blocks.

### Recommended Workflow

Protect local-only code for the first time:

```text
Change code to the local version
Select the local code
Right-click the selection and run Personal Git Process -> Protect Selection as Local Block
Run Install Local Block Pre-Commit Guard
```

Daily development:

```text
Keep the local version visible in the editor
Git filter makes Git see the public version
Run Show Public Version when you want to inspect public text
Run Apply Local Blocks when you want to restore local text
Open the Personal Git sidebar when you want to manage one block
```

Sync remote updates:

```text
Run Safe Sync With Local Blocks
```

Release a new extension version:

```powershell
npm run compile
git add .
git commit -m "Release 0.0.x"
git push origin main
git tag v0.0.x
git push origin v0.0.x
```

Pushing the tag triggers GitHub Actions to publish the extension to the VS Code Marketplace.

### Current Limits

- Local Blocks use text replacement, not AST parsing.
- They work best with one continuous selection.
- If the same text appears multiple times in a file, the first match may be used.
- If the remote changes the same public block, the extension marks a conflict and asks for manual handling.
- If you edit local block text after protecting it, protect it again or update the saved block.
- Menus, commands, and primary prompts support English and Simplified Chinese. VS Code `zh-cn` uses Chinese; all other locales use English.

### Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

### Package

```bash
npm run compile
npm run package
```
