/**
 * dsh-sidebar-context-menu 的离线冒烟测试（不需要浏览器、不需要联网、不需要 React 包）。
 *
 * 覆盖：
 *   1. lib/client.js 能被 __ModuleLoader__ 正常加载、apply 能装上监听；
 *   2. 右键非工作区元素时**不拦截**；工作区行上的 data-row-key 前缀能挡住别的行；
 *   3. 右键工作区行时挂出菜单容器，菜单项齐全（含装了 projectTabs 时的「在新标签中打开」）；
 *   4. 点「重命名 / 删除工作区」调用到行组件 props 上的 actions；
 *   5. 点「VS Code / 资源管理器」POST 到宿主路由，路径正确；
 *   6. 点「在新标签中打开」调用 projectTabs 服务；
 *   7. 选完菜单即卸载容器。
 *
 * 做法：用迷你 hook 运行时“渲染”Menu（官方组件在这里是替身），
 * 把 react/jsx-runtime 的产物当普通 `{type, props}` 对象树来断言；
 * DOM 借本机 DSH 里的 @mixmark-io/domino。
 *
 * 用法：node scripts/smoke-test.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/* ------------------------------------------------------------------ domino */

function resolveDomino() {
  const candidates = [
    process.env.DSH_DOMINO,
    'H:/node/node_global/node_modules/@deepseek-ai/dsh/node_modules/@mixmark-io/domino',
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@mixmark-io', 'domino'),
    join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@mixmark-io', 'domino'),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return 'domino';
}

const domino = require(resolveDomino());
const win = domino.createWindow('<!doctype html><html><body></body></html>');
const doc = win.document;

function define(target, name, value) {
  try {
    target[name] = value;
  } catch {
    try {
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
    } catch {
      /* 改不动就跳过 */
    }
  }
}

define(win, 'innerWidth', 1280);
define(win, 'innerHeight', 800);
define(win, 'setTimeout', globalThis.setTimeout);
define(win, 'clearTimeout', globalThis.clearTimeout);

globalThis.window = win;
globalThis.document = doc;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

/* domino 只实现了一部分 DOM，这里补上插件用到的那几处。 */
const elementProto = Object.getPrototypeOf(doc.createElement('div'));
if (typeof elementProto.remove !== 'function') {
  elementProto.remove = function remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  };
}

/* 捕获 window 上的全局监听（contextmenu），测试里手动触发。 */
const windowHandlers = {};
const rawWindowAdd = win.addEventListener.bind(win);
win.addEventListener = (type, handler, options) => {
  (windowHandlers[type] = windowHandlers[type] || []).push(handler);
  rawWindowAdd(type, handler, options);
};

/* --------------------------------------------------- 迷你 React / 假模块 */

const mini = {
  stack: [{ slots: [], index: 0 }],
  frame() {
    return this.stack[this.stack.length - 1];
  },
  reset() {
    this.stack = [{ slots: [], index: 0 }];
  },
};

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (!Object.is(left[index], right[index])) return false;
  return true;
}

const Fragment = Symbol('Fragment');

const React = {
  useCallback(callback, deps) {
    const frame = mini.frame();
    const at = frame.index++;
    const slot = frame.slots[at];
    if (slot !== undefined && sameDeps(slot[1], deps)) return slot[0];
    frame.slots[at] = [callback, deps];
    return callback;
  },
};

const jsxRuntime = {
  Fragment,
  jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
  jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
};

const primitives = {
  Menu: 'Menu',
  IconEditOutlineRegular: 'IconEdit',
  IconTrashOutlineRegular: 'IconTrash',
  IconCodeOutlineRegular: 'IconCode',
  IconFolderOpenRegular: 'IconFolderOpen',
  IconProjectAddOutlineRegular: 'IconProjectAdd',
};

/** createRoot 替身：记住 render 出来的元素树，unmount 时标记。 */
const roots = [];
const reactDomClient = {
  createRoot: (container) => {
    const record = { container, tree: null, unmounted: false, renderCount: 0 };
    roots.push(record);
    return {
      render: (element) => {
        record.tree = element;
        record.renderCount += 1;
      },
      unmount: () => {
        record.unmounted = true;
      },
    };
  },
};

const modules = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom/client': reactDomClient,
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
};

/* ------------------------------------------------------------ 加载插件 */

const source = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8');
let entry = null;
win.__ModuleLoader__ = { load: (value) => { entry = value; } };
vm.runInThisContext(source, { filename: 'lib/client.js' });

/* ------------------------------------------------------------ 断言工具 */

const failures = [];
function check(name, condition) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}`);
    failures.push(name);
  }
}

const isElement = (value) => value !== null && typeof value === 'object' && 'type' in value && 'props' in value;

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isElement(node)) return;
  if (typeof node.type === 'function') {
    mini.stack.push({ slots: [], index: 0 });
    let rendered = null;
    try {
      rendered = node.type(node.props);
    } finally {
      mini.stack.pop();
    }
    walk(rendered, visit);
    return;
  }
  visit(node);
  walk(node.props.children, visit);
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

function fireContextMenu(target) {
  const handlers = windowHandlers.contextmenu || [];
  let prevented = false;
  let stopped = false;
  for (const handler of handlers) {
    handler({
      target,
      clientX: 200,
      clientY: 150,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    });
  }
  return { prevented, stopped, handlers: handlers.length };
}

/* ------------------------------------------------------------ 1. 模块加载 */

console.log('1) 模块加载');
check('__ModuleLoader__.load 被调用且 id 正确', entry !== null && entry.id === 'dsh-sidebar-context-menu');
const mod = entry === null ? {} : entry.factory((name) => {
  if (name in modules) return modules[name];
  throw new Error(`测试替身缺少模块：${name}`);
});
check('导出 apply 函数', typeof mod.apply === 'function');
check('inject 声明了 locale', Array.isArray(mod.inject) && mod.inject.includes('locale'));

const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
check('dsh.client.platform === "web"', manifest.dsh?.client?.platform === 'web');
check('exports["./client"] 指向 lib/client.js', manifest.exports?.['./client']?.default === './lib/client.js');

/* ------------------------------------------------------------ 2. apply */

console.log('2) apply(ctx)');
const effectLabels = [];
const tabsCalls = [];
const tabsService = {
  openWorkspaceInTab: async (workspaceId) => { tabsCalls.push(workspaceId); return `session-of-${workspaceId}`; },
};

const ctx = {
  get: (name) => (name === 'projectTabs' ? tabsService : undefined),
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  effect: (callback, label) => {
    const dispose = callback();
    effectLabels.push({ label, dispose });
    return () => {};
  },
};

let applyThrew = null;
try {
  mod.apply(ctx);
} catch (error) {
  applyThrew = error;
}
check('apply 不抛异常', applyThrew === null, applyThrew?.message);
check('注册了 contextmenu 监听', (windowHandlers.contextmenu || []).length === 1);
check('注册了文案字典与清理钩子', effectLabels.length >= 1);

/* ------------------------------------------------------------ 3. 不误伤 */

console.log('3) 不误伤其它右键');
const plain = doc.createElement('div');
doc.body.appendChild(plain);
const plainResult = fireContextMenu(plain);
check('普通元素右键不 preventDefault', plainResult.prevented === false);
check('普通元素右键不挂菜单', roots.length === 0);

/* 会话行（data-row-key 不是 workspace:）即便 fiber 像工作区行也必须放行 */
const sessionRow = doc.createElement('div');
sessionRow.setAttribute('data-row-key', 'session:s-1');
const sessionTitle = doc.createElement('span');
sessionRow.appendChild(sessionTitle);
doc.body.appendChild(sessionRow);
sessionTitle.__reactFiber$smoke = {
  memoizedProps: { className: 'title' },
  return: { memoizedProps: {
    group: { key: 'ws-1', workspaceId: 'ws-1', cwd: 'C:\\x', label: 'x' },
    actions: { rename: () => {}, delete: () => {} },
  }, return: null },
};
const sessionResult = fireContextMenu(sessionTitle);
check('data-row-key=session:* 的行不被拦截', sessionResult.prevented === false && roots.length === 0);

/* ------------------------------------------------------------ 4. 工作区行 */

console.log('4) 工作区行右键弹菜单');
const cwd = 'C:\\Users\\Administrator\\源码\\【20.八神】\\大程序源码';
const calls = { rename: 0, remove: 0 };
const rowProps = {
  group: { key: 'ws-1', workspaceId: 'ws-1', cwd, label: '大程序源码' },
  actions: {
    rename: () => { calls.rename += 1; },
    delete: () => { calls.remove += 1; },
  },
  onToggle: () => {},
};

const row = doc.createElement('div');
row.setAttribute('data-row-key', 'workspace:ws-1');
const title = doc.createElement('span');
title.textContent = '大程序源码';
row.appendChild(title);
doc.body.appendChild(row);
title.__reactFiber$smoke = {
  memoizedProps: { className: 'title' },
  return: { memoizedProps: rowProps, return: null },
};

const rowResult = fireContextMenu(title);
check('工作区行右键 preventDefault', rowResult.prevented === true);
check('工作区行右键 stopPropagation', rowResult.stopped === true);
check('挂了菜单容器', roots.length === 1 && roots[0].container.parentNode !== null);

const rootRecord = roots[0];
mini.reset();
const menus = findAll(rootRecord.tree, (node) => node.type === 'Menu');
check('渲染出官方 Menu', menus.length === 1);
const menu = menus[0];
check('菜单钉在鼠标位置', typeof menu.props.getAnchorRect === 'function'
  && menu.props.getAnchorRect().left === 200
  && menu.props.getAnchorRect().top === 150);
check('菜单是 portal + 自动聚焦', menu.props.portal === true && menu.props.autoFocus === true);

const itemIds = menu.props.items.map((item) => item.id);
check('菜单含重命名 / 删除 / VS Code / 资源管理器',
  ['rename', 'delete', 'vscode', 'explorer'].every((id) => itemIds.includes(id)), itemIds.join(','));
check('删除项标了 danger', menu.props.items.find((item) => item.id === 'delete')?.danger === true);
check('装了 projectTabs 时多出「在新标签中打开」', itemIds.includes('tab'), itemIds.join(','));
check('有分隔线', menu.props.items.some((item) => item.type === 'separator'));

/* ------------------------------------------------------------ 5. 菜单动作 */

console.log('5) 菜单动作');
menu.props.onSelect('rename');
check('重命名调用 actions.rename', calls.rename === 1);
check('选完即卸载菜单并从文档里摘掉容器',
  rootRecord.unmounted === true && rootRecord.container.parentNode === null);

fireContextMenu(title);
const second = roots[1];
mini.reset();
second.tree = second.tree ?? null;
findAll(second.tree, () => false); /* 触发展开，保证 useCallback 走到 */
const secondMenu = findAll(second.tree, (node) => node.type === 'Menu')[0];
secondMenu.props.onSelect('delete');
check('删除调用 actions.delete', calls.remove === 1);

const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return { ok: true, json: async () => ({ ok: true, via: 'test-launcher' }) };
};

fireContextMenu(title);
const thirdMenu = findAll(roots[2].tree, (node) => node.type === 'Menu')[0];
thirdMenu.props.onSelect('explorer');
await Promise.resolve();
await Promise.resolve();
check('资源管理器 POST 到宿主路由', fetchCalls.length === 1 && fetchCalls[0].url === '/dsh-sidebar-context-menu/open');
check('资源管理器 payload 正确', fetchCalls[0]?.init?.body === JSON.stringify({ target: 'explorer', path: cwd }));

fireContextMenu(title);
const fourthMenu = findAll(roots[3].tree, (node) => node.type === 'Menu')[0];
fourthMenu.props.onSelect('vscode');
await Promise.resolve();
await Promise.resolve();
check('VS Code payload 正确', fetchCalls[1]?.init?.body === JSON.stringify({ target: 'vscode', path: cwd }));

fireContextMenu(title);
const fifthMenu = findAll(roots[4].tree, (node) => node.type === 'Menu')[0];
fifthMenu.props.onSelect('tab');
await Promise.resolve();
check('「在新标签中打开」调用 projectTabs 服务', tabsCalls.length === 1 && tabsCalls[0] === 'ws-1');

/* ------------------------------------------------------------ 6. 没装 tabs 插件 */

console.log('6) 没装 dsh-project-tabs 时不显示该项');
const bareCtx = { ...ctx, get: () => undefined };
mod.apply(bareCtx);
fireContextMenu(title);
const bareMenu = findAll(roots[roots.length - 1].tree, (node) => node.type === 'Menu')[0];
check('菜单里没有「在新标签中打开」', !bareMenu.props.items.some((item) => item.id === 'tab'),
  bareMenu.props.items.map((item) => item.id).join(','));

/* ------------------------------------------------------------ 收尾 */

console.log('');
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('ALL PASS');
}
