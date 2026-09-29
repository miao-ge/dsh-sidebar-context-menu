/**
 * dsh-sidebar-context-menu — 客户端半边（DSH 左侧工作区行的右键菜单）。
 *
 * 效果：在左侧「工作区行」上点右键，弹出官方样式的菜单：
 *   重命名 / 删除工作区 / 使用 VS Code 打开 / 在资源管理器中打开
 *   另外：装了 dsh-project-tabs 时多一项「在新标签中打开」
 *
 * 实现要点（0.2.0 版）：
 *  1. 菜单本体换成官方组件：`Menu`（来自 @deepseek-ai/dsh-client-ui-primitives）
 *     自己处理定位、视口夹取、键盘导航、点外部/Esc 关闭，我们只提供锚点矩形。
 *     因为它是 React 组件，而右键事件是命令式的，所以这里按需 mount 一个
 *     react-dom/client 的 root，关闭时 unmount 并摘掉容器。
 *  2. 重命名、删除：直接调用该行 React 组件 props 上的 actions.rename() / actions.delete()，
 *     与内置「…」按钮走同一套逻辑（会打开官方对话框）；我们只是换个入口。
 *  3. 「打开 VS Code / 资源管理器」浏览器做不到，POST 给宿主半边
 *     /dsh-sidebar-context-menu/open，由宿主用系统命令拉起。
 *  4. 工作区行没有把 workspaceId / cwd 暴露到 DOM 上，所以用 React fiber
 *     （DOM 节点上的 __reactFiber$ 键）向上找到 ProjectRowItem 的 props（group + actions）
 *     来读数据。0.2.0 里这一行的 props 形状没变；行上还多了
 *     data-row-key="workspace:<id>"，可以拿它做一次廉价的前置过滤。
 *     找不到工作区行就完全不拦截这次右键。
 *  5. 「在新标签中打开」通过客户端服务 `projectTabs` 调用（dsh-project-tabs 提供），
 *     读的时候同时看 ctx.get 和 window 兜底；没装那个插件就不显示这一项。
 *
 * 这个文件不需要打包：DSH 的客户端模块系统直接执行 window.__ModuleLoader__.load，
 * 而 react / react-dom/client / ui-primitives 都在平台静态模块表里，直接 require 即可。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-context-menu',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const { useCallback } = require('react');
    const { jsx } = require('react/jsx-runtime');
    const { createRoot } = require('react-dom/client');
    const {
      Menu,
      IconEditOutlineRegular,
      IconTrashOutlineRegular,
      IconCodeOutlineRegular,
      IconFolderOpenRegular,
      IconProjectAddOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives');

    /** 宿主路由（与 lib/index.js 保持一致）。 */
    const OPEN_ENDPOINT = '/dsh-sidebar-context-menu/open';
    /** 运行时探测用的标记属性（也是离线冒烟测试的抓手）。 */
    const MENU_ATTR = 'data-dsh-sidebar-context-menu';
    /** 本地化命名空间。 */
    const NS = 'sidebar-context-menu';

    /* ------------------------------------------------------------ 文案 */

    const zh = {
      rename: '重命名',
      remove: '删除工作区',
      vscode: '使用 VS Code 打开',
      explorer: '在资源管理器中打开',
      openInTab: '在新标签中打开',
      noPath: '这个工作区没有可用路径',
      failed: '打开失败：宿主没有找到对应程序',
    };
    const en = {
      rename: 'Rename',
      remove: 'Delete workspace',
      vscode: 'Open in VS Code',
      explorer: 'Reveal in File Explorer',
      openInTab: 'Open in new tab',
      noPath: 'This workspace has no usable path',
      failed: 'Open failed: no handler found on the host',
    };

    /* -------------------------------------------------- React fiber 取值 */

    /**
     * 取一个 DOM 节点上的 React fiber。
     * React 18/19 在生产构建里也会在宿主节点上写 __reactFiber$<random>。
     */
    function fiberOf(node) {
      if (node === null || typeof node !== 'object') return null;
      for (const key of Object.keys(node)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return node[key];
      }
      return null;
    }

    /**
     * 从右键目标往上找「工作区行」的 props。
     * ProjectRowItem 的 props 形如 { group, onToggle, onCreate, actions, drag, home, t }，
     * 其中 actions = { rename, delete } 只对真实工作区存在（未分组行两者都没有），是最稳的特征。
     * @returns props 对象，或 null（不是工作区行）。
     */
    function resolveWorkspaceRow(target) {
      let node = target;
      if (node !== null && node !== undefined && node.nodeType === 3) node = node.parentElement;
      if (node === null || node === undefined || node.nodeType !== 1) return null;

      let fiber = fiberOf(node);
      let hops = 0;
      while (fiber !== null && fiber !== undefined && hops < 60) {
        const props = fiber.memoizedProps;
        if (
          props !== null
          && typeof props === 'object'
          && props.group !== undefined
          && props.actions !== undefined
          && typeof props.actions.rename === 'function'
          && typeof props.actions.delete === 'function'
          && typeof props.group.workspaceId === 'string'
        ) {
          return props;
        }
        fiber = fiber.return;
        hops += 1;
      }
      return null;
    }

    /* -------------------------------------------------------------- 菜单 */

    /** 当前挂着的菜单宿主与 React root。 */
    let menuHost = null;
    let menuRoot = null;
    /** 当前的客户端根上下文（apply 时记下，右键时用来取服务 / 文案）。 */
    let rootCtx = null;

    /** 关掉当前菜单：卸载 React 树并摘掉容器。 */
    function closeMenu() {
      const host = menuHost;
      const root = menuRoot;
      menuHost = null;
      menuRoot = null;
      if (root !== null) {
        try {
          root.unmount();
        } catch (error) {
          console.warn('[dsh-sidebar-context-menu] unmount failed:', error);
        }
      }
      if (host !== null) host.remove();
    }

    /** 小提示条：打开失败之类的情况给一句反馈。 */
    function toast(message) {
      if (document.body === null) return;
      const el = document.createElement('div');
      el.textContent = message;
      el.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:28px',
        'transform:translateX(-50%)',
        'z-index:2147483647',
        'padding:8px 14px',
        'border-radius:8px',
        'font-size:13px',
        'font-family:inherit',
        'background:var(--dsw-alias-button-elevated-fill,#2f2f31)',
        'color:var(--dsw-alias-label-primary,#ececec)',
        'box-shadow:0 6px 20px rgba(0,0,0,.35)',
        'pointer-events:none',
        'white-space:nowrap',
      ].join(';');
      document.body.appendChild(el);
      window.setTimeout(() => el.remove(), 2600);
    }

    /**
     * 请宿主拉起外部程序。
     * @returns {{ ok: boolean, via: string }} via 是宿主实际用的命令（便于排查开错程序）。
     */
    async function openExternal(target, path) {
      try {
        const response = await fetch(OPEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target, path }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || data === null || data.ok !== true) return { ok: false, via: '' };
        return { ok: true, via: typeof data.via === 'string' ? data.via : '' };
      } catch {
        return { ok: false, via: '' };
      }
    }

    /**
     * 一次右键菜单的 React 组件。
     * 用 portal 模式 + 显式锚点矩形，把菜单钉在鼠标位置；Menu 自己负责
     * 视口夹取、键盘导航和「点外部 / Esc 关闭」。
     */
    function WorkspaceContextMenu({ x, y, items, onSelect, onClose }) {
      const getAnchorRect = useCallback(
        () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }),
        [x, y],
      );
      return jsx(Menu, {
        open: true,
        anchor: null,
        items,
        portal: true,
        autoFocus: true,
        align: 'start',
        side: 'bottom',
        getAnchorRect,
        onSelect,
        onClose,
      });
    }

    /**
     * 在 (x, y) 处打开菜单。
     * @param props - 工作区行的 React props（含 group / actions）。
     * @param x - 视口坐标。
     * @param y - 视口坐标。
     */
    function openMenu(props, x, y) {
      closeMenu();
      if (rootCtx === null) return;

      const group = props.group ?? {};
      const workspaceId = typeof group.workspaceId === 'string' ? group.workspaceId : '';
      const cwd = typeof group.cwd === 'string' ? group.cwd : '';
      /* 文案：拿不到 locale 服务（或命名空间还没注册）就退回键名，绝不让菜单打不开 */
      let t = (key) => key;
      try {
        if (typeof rootCtx.locale?.bind === 'function') t = rootCtx.locale.bind(NS);
      } catch (error) {
        console.warn('[dsh-sidebar-context-menu] locale bind failed:', error);
      }

      /* 「在新标签中打开」只有装了 dsh-project-tabs 才出现 */
      const tabs = rootCtx.get?.('projectTabs') ?? globalThis.__DSH_PROJECT_TABS__ ?? null;
      const canOpenInTab = tabs !== null && typeof tabs.openWorkspaceInTab === 'function' && workspaceId !== '';

      const items = [
        { id: 'rename', label: t('rename'), icon: jsx(IconEditOutlineRegular, {}) },
        { id: 'delete', label: t('remove'), icon: jsx(IconTrashOutlineRegular, {}), danger: true },
        { id: 'sep1', type: 'separator' },
        { id: 'vscode', label: t('vscode'), icon: jsx(IconCodeOutlineRegular, { size: 14 }) },
        { id: 'explorer', label: t('explorer'), icon: jsx(IconFolderOpenRegular, { size: 14 }) },
      ];
      if (canOpenInTab) {
        items.push({ id: 'sep2', type: 'separator' });
        items.push({ id: 'tab', label: t('openInTab'), icon: jsx(IconProjectAddOutlineRegular, { size: 14 }) });
      }

      const onSelect = (id) => {
        closeMenu();
        if (id === 'rename') {
          try {
            props.actions.rename();
          } catch (error) {
            console.warn('[dsh-sidebar-context-menu] rename failed:', error);
          }
          return;
        }
        if (id === 'delete') {
          try {
            props.actions.delete();
          } catch (error) {
            console.warn('[dsh-sidebar-context-menu] delete failed:', error);
          }
          return;
        }
        if (id === 'tab') {
          tabs.openWorkspaceInTab(workspaceId).catch((reason) => {
            console.warn('[dsh-sidebar-context-menu] open in tab failed:', reason);
          });
          return;
        }
        if (cwd === '') {
          toast(t('noPath'));
          return;
        }
        openExternal(id === 'vscode' ? 'vscode' : 'explorer', cwd).then((result) => {
          if (!result.ok) {
            toast(t('failed'));
            return;
          }
          /* 便于排查「开错程序 / 没反应」：看 F12 控制台这行就知道宿主用了什么命令 */
          console.info(`[dsh-sidebar-context-menu] ${id} -> ${result.via || 'ok'}`);
        });
      };

      menuHost = document.createElement('div');
      menuHost.setAttribute(MENU_ATTR, '1');
      menuHost.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647';
      document.body.appendChild(menuHost);
      menuRoot = createRoot(menuHost);
      menuRoot.render(jsx(WorkspaceContextMenu, {
        x,
        y,
        items,
        onSelect,
        onClose: () => closeMenu(),
      }));
    }

    /* -------------------------------------------------------------- 安装 */

    /** 全局 contextmenu 拦截：只有命中工作区行才接管。 */
    function onContextMenu(event) {
      const target = event.target;
      /* 廉价前置过滤：行上有 data-row-key 时，非 workspace: 前缀的直接放行。 */
      if (target !== null && target !== undefined && typeof target.closest === 'function') {
        const rowKey = target.closest('[data-row-key]')?.getAttribute('data-row-key') ?? '';
        if (rowKey !== '' && !rowKey.startsWith('workspace:')) return;
      }
      const props = resolveWorkspaceRow(target);
      if (props === null) return;
      event.preventDefault();
      event.stopPropagation();
      openMenu(props, event.clientX, event.clientY);
    }

    function install() {
      window.addEventListener('contextmenu', onContextMenu, true);
      console.info('[dsh-sidebar-context-menu] installed');
      return () => {
        window.removeEventListener('contextmenu', onContextMenu, true);
        closeMenu();
      };
    }

    /**
     * cordis 客户端插件入口。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      rootCtx = ctx;
      if (typeof ctx.locale?.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sidebar-context-menu: dictionaries');
      }
      const teardown = install();
      if (ctx !== null && typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          rootCtx = null;
          teardown();
        }, 'sidebar-context-menu: workspace row context menu');
      }
    }

    exports.apply = apply;
    exports.inject = ['locale'];
    exports.name = 'sidebar-context-menu';
    return module.exports;
  },
});
