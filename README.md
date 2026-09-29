# dsh-sidebar-context-menu

给 **DSH 左侧菜单**（工作区 / 会话列表里的「工作区行」）加一个**右键菜单**：

| 菜单项 | 行为 |
| --- | --- |
| 重命名 | 和原来「…」按钮一样，打开官方重命名对话框 |
| 删除工作区 | 和原来「…」按钮一样，打开官方删除确认框 |
| 使用 VS Code 打开 | `<Code.exe> --new-window <路径>`：**新开一个窗口**，不动你当前那个窗口 |
| 在资源管理器中打开 | 宿主执行 `explorer.exe <路径>`，直接进入该目录 |
| 在新标签中打开 | **装了 [dsh-project-tabs](https://github.com/miao-ge/dsh-project-tabs) 才出现**：把该项目在新标签里打开 |

原来要靠 `…` 按钮的两项没有删掉，只是多了一个右键入口；其余是新增的。

菜单用的是 DSH 官方组件（`@deepseek-ai/dsh-client-ui-primitives` 的 `Menu` + 图标），
所以外观、键盘导航、点外部 / Esc 关闭都是原生的那一套。

## 安装

**用 dsh 自带的插件安装器（推荐）：**

```sh
dsh plugin --profile desktop add dsh-sidebar-context-menu
```

桌面端也可以直接在界面里装：左侧栏「插件」→「添加插件」→ 填包名 → 安装 → 立即启用。

**从源码装（开发用）：** 克隆本仓库，然后

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本会读本仓库 `package.json` 里的包名，所以两个插件仓库里是同一份脚本。
**默认装进 `desktop` profile**——桌面端（DeepSeek Harness 0.2.0 桌面版）读的就是它；
`web` profile 是给浏览器版 `dsh web` 用的。想装那边就加 `-Profile web`，
两边都装用 `-Profile both`。它是幂等的，可以反复运行。

脚本（不需要 pnpm）：

1. 在 C 盘建「发布点」`<DSH_HOME>\plugins\<包名>`，它是指向源码目录的 **junction**
   —— 源码仍然是活的，改完不用重新发布；
2. `dependencies` 写同盘符的相对链接 `link:../../plugins/<包名>`；
3. 直接建 `<profile>\node_modules\<包名>` 的 junction 指向发布点；
4. **校验链接真能解析到插件清单之后**，才把包名写进 `dsh.profile.bundles`
   （bundle 行指向解析不到的包会让该 profile 起不来或整条 bundle 被跳过）。

然后：

1. 重启桌面端（桌面端的 profile 是活的，开了 HMR 的话可能已经热挂上了）；
2. 页面硬刷新（Ctrl+Shift+R）；
3. 左侧工作区行上右键 → 应该看到官方样式的菜单。

卸载：`.\scripts\install.ps1 -Uninstall`，然后重启 + 硬刷新。

### 为什么不能直接 `dsh plugin --profile desktop add link:H:/DSH`

pnpm 10 在 Windows 上把 `link:` / `file:` 的路径当**相对 profile 目录**处理。profile 在 `C:`、
源码在 `H:` 时跨盘符无法表示相对路径，于是 pnpm 退化成 `path.join`，生成垃圾链接：

```
node_modules\dsh-sidebar-context-menu -> C:\Users\...\.dsh\profiles\desktop\H:\DSH   ← 不存在
```

所以本脚本先把源码「代理」到 C 盘的 `<DSH_HOME>\plugins\...`（junction → 源码目录），
再用**同盘符的相对链接**。脚本自己建 junction，连 pnpm 都不用跑。

## 0.2.0 兼容性（和 0.1.7 的差异）

对着 0.2.0 的 `dsh-client-ui-workspace/lib/client.js` 核对过，**原来那套识别逻辑没变**：

| 依赖点 | 0.2.0 |
| --- | --- |
| `ProjectRowItem` 的 props `{group, actions}` | 签名一致（`:1270`），调用点 `:2509-2539` 形状不变 |
| `actions = {rename, delete}` 只对真实工作区存在 | 仍在 `:2529`（未分组行 `workspaceId` 和 `actions` 双双为 undefined） |
| `group.workspaceId / cwd / label` | 仍在（`buildGroup :395`，`cwd = workspace.path`） |
| 宿主 `ctx.webServer.register({kind:'prefix',path,handler})` | 契约不变，handler 仍独占 response（`dsh-host-webserver/lib/index.js:177`） |
| 桌面端的 loopback 围栏 | 桌面代理转发任意方法/body 并删掉 `origin` 头（`lib/main.js:7461-7492`），围栏照旧通过 |

0.2.0 顺手用上的两个新东西：

- 工作区行多了 `data-row-key="workspace:<id>"`（`:1287`），做一个**廉价前置过滤**：
  右键落在 `data-row-key` 不是 `workspace:` 前缀的行上（比如会话行）直接放行，不做 fiber 回溯；
- 客户端 bundle 可以直接 `require` 平台静态模块表里的官方组件，菜单因此换成了 `Menu`。

### 打开方式踩过的坑（宿主半边，仍然有效）

- **资源管理器点了没反应**：`spawn` 里带 `windowsHide: true` 会给子进程
  `STARTF_USESHOWWINDOW | SW_HIDE`，`explorer.exe` 会把窗口真建成隐藏的。**不要加这个选项。**
- **VS Code 顶掉当前窗口**：`vscode://file/...` 走 VS Code 自己的 URL 处理器，默认沿用当前窗口；
  改成 CLI `Code.exe --new-window <path>`。
  另外 `PATH` 上的第一个 `code.cmd` 很可能是 **Cursor** 的，所以启动器按这个顺序找：
  `DSH_SCM_VSCODE` 环境变量 → 注册表 `HKCR\vscode\shell\open\command` 里的 `Code.exe`
  （本机是 `D:\Program Files\Microsoft VS Code\Code.exe`）→ 常见安装目录 → `PATH`。
- 排查：点击后浏览器 F12 会打印宿主实际用的命令，例如
  `[dsh-sidebar-context-menu] vscode -> vscode-cli D:\Program Files\Microsoft VS Code\Code.exe`。
  想换成 Cursor / Windsurf：设 `DSH_SCM_VSCODE=<它的 exe 或 code.cmd 路径>`，重启桌面端 / dsh web。

> 0.2.0 自带 `dsh-host-open-in-app`（`POST /open-in-app/open`，目录里就有 `vscode` 和 `explorer`），
> 理论上可以复用。之所以没用：它不带 `--new-window`（会顶掉你当前的 VS Code 窗口），
> 而且 `explorer` 是 `/select,<dir>`（在父目录里选中文件夹）而不是直接进目录。

## DSH 自己的工作区 / 归档语义（跟插件无关，但容易踩）

数据都在 `~/.dsh/storages/workspace.json`：

```json
{ "global": { "workspaceIds": ["..."], "archivedSessionIds": ["..."] },
  "tables": { "workspaces": { "<id>": { "path": "...", "title": "...", "sessionIds": ["..."] } } } }
```

- **删除工作区** = 只删登记行（`tables.workspaces.<id>` + `global.workspaceIds` 里的 id）。
  目录和会话日志都不动，会话掉进「未分组」。找回：重新添加同一目录建工作区，
  再把老会话**拖**进那个分组（UI 支持拖拽 → `insertSessionBefore`）。
- **归档会话** = 把 id 加进 `global.archivedSessionIds`（全局列表）。数据都在：
  从数组里删掉 id（重启 + 硬刷新）就回到原分组，位置也不变。
- 归档 **不省空间**。会话日志在 `~/.dsh/sessions/<路径转义>/<session-id>/session.jsonl.zstd`；
  要省空间只能删这些目录，删了历史就真没了。

## 文件

```
package.json               DSH 插件清单（dsh.bundle.patch + dsh.client）
cordis.patch.yml           bundle patch：把本插件的一行插进 profile 插件树
lib/index.js               宿主半边：POST /dsh-sidebar-context-menu/open
lib/client.js              客户端半边：右键拦截 + 官方 Menu（无需打包）
scripts/install.ps1        安装 / 卸载（发布点 + junction + bundles + 校验）
scripts/smoke-test.mjs     客户端离线冒烟测试
scripts/host-test.mjs      宿主半边离线测试
```

配套的另一个插件（窗口顶部的项目标签栏）在
[dsh-project-tabs](https://github.com/miao-ge/dsh-project-tabs) 仓库里。

## 原理（为什么这么写）

- 左侧菜单内容由内置包 `@deepseek-ai/dsh-client-ui-workspace` 渲染。0.2.0 里
  `sidebar.workspaces` 是 `single` 插槽且已被占用，它下面的
  `sidebar.workspaces.session.menu.item` / `sidebar.session.row.action` 全是**按会话**的
  （owner props 是 `{sessionId, displayTitle}`），**没有任何「工作区行」的菜单插槽**。
  而那个包是编译产物（只有 `lib/client.js`），改它又会被升级覆盖。所以这里改用**事件层**介入：
  1. 在 `window` 上挂 `contextmenu` 监听（捕获阶段）。
  2. 用 `data-row-key` 做一次廉价前置过滤（非 `workspace:` 前缀直接放行）。
  3. 命中目标时用 **React fiber**（DOM 节点上的 `__reactFiber$<random>` 键）向上找到
     `ProjectRowItem` 的 props —— `actions = { rename, delete }` 只对真实工作区存在，是最稳的特征。
  4. 从 `group` 拿 `workspaceId / cwd / label`，从 `actions` 复用官方的重命名 / 删除。
  5. 找不到工作区行就完全不拦截，不影响页面上其它任何右键。
- 菜单本体是官方 `Menu` 组件，而右键是命令式的，所以按需 `createRoot` 一个小 React 根，
  关掉时 `unmount()` + 摘掉容器（`Menu` 自己处理定位、夹取、键盘导航、点外部 / Esc 关闭）。
- 「打开资源管理器 / VS Code」浏览器做不到，所以走宿主：
  `lib/index.js` 注册 `POST /dsh-sidebar-context-menu/open`，用
  `explorer.exe <path>` / `rundll32.exe url.dll,FileProtocolHandler vscode://file/<path>` **detached** 拉起，
  请求只接受本机 loopback（同源）调用。
- 「在新标签中打开」走另一个插件提供的客户端服务 `projectTabs`，读的时候
  `ctx.get('projectTabs') ?? window.__DSH_PROJECT_TABS__`，没装就整项不显示。

## 测试

```powershell
node scripts\smoke-test.mjs   # 客户端：加载 bundle、fiber 识别、菜单、动作分发
node scripts\host-test.mjs    # 宿主：URL 构造、loopback 围栏、请求校验
```

两个都是离线的（不需要浏览器 / 联网 / 安装 React），DOM 借本机 DSH 安装里的
`@mixmark-io/domino`（也可用环境变量 `DSH_DOMINO` 指定）。

## 已知限制

- 只在**浏览器端那个 Web 客户端**里生效（桌面端也是它）。VSCode 扩展
  `mrtsels.dsh-for-vs-code` 自带一份打包好的客户端 UI，不读 profile 里的插件。
- 依赖 React 18/19 在宿主节点上挂 `__reactFiber$` 这一事实；DSH 大版本升级后如果识别不到，
  右键会安静地不生效（不会报错、不会影响其它功能），届时需要按新结构复查 `resolveWorkspaceRow`。
- 升级 / 重装 DSH、profile 被重置、或桌面端走了「禁用所有插件」的恢复流程后，
  `dsh.profile.bundles` 会丢，重跑一次 `install.ps1` 即可。
- 仓库目录移动后 junction 会失效，重跑 `install.ps1` 会重建。
- 未分组（Ungrouped）那一段没有工作区实体，右键不会弹菜单（符合预期）。
