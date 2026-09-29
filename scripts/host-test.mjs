/**
 * 宿主半边的离线测试（不联网、不真的拉起任何外部程序）。
 *
 * 覆盖：vscode:// URL 构造、路由注册形态、请求校验（loopback 围栏 / 方法 /
 * 路径 / 参数）。成功分支会真的 spawn explorer.exe / rundll32，测试里故意不碰。
 *
 * 用法：node scripts/host-test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const host = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href);

const failures = [];
function check(name, condition) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}`);
    failures.push(name);
  }
}

/* ---------------------------------------------------- 1. URL 构造 */

console.log('1) vscode:// URL 构造');
check(
  '盘符 / 空格 / 中文 / # 都被正确处理',
  host.toVscodeFileUrl('C:\\Users\\a b\\中文#1\\x') === 'vscode://file/C:/Users/a%20b/%E4%B8%AD%E6%96%87%231/x',
);
check('正斜杠路径同样处理', host.toVscodeFileUrl('D:/work/demo') === 'vscode://file/D:/work/demo');

/* ---------------------------------------------------- 2. loopback 围栏 */

console.log('2) loopback 围栏');
const loopbackReq = (extra = {}) => ({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: '127.0.0.1:3080', ...extra },
});
check('本机 socket + 本机 Host → 允许', host.isLoopbackRequest(loopbackReq()) === true);
check('::1 → 允许', host.isLoopbackRequest({ socket: { remoteAddress: '::1' }, headers: { host: 'localhost:3080' } }) === true);
check('非本机 socket → 拒绝', host.isLoopbackRequest({ socket: { remoteAddress: '10.0.0.5' }, headers: { host: '127.0.0.1' } }) === false);
check('非本机 Host → 拒绝', host.isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example.com' } }) === false);
check('跨站 sec-fetch-site → 拒绝', host.isLoopbackRequest(loopbackReq({ 'sec-fetch-site': 'cross-site' })) === false);
check('同源 Origin → 允许', host.isLoopbackRequest(loopbackReq({ origin: 'http://127.0.0.1:3080' })) === true);
check('异源 Origin → 拒绝', host.isLoopbackRequest(loopbackReq({ origin: 'http://evil.example.com' })) === false);

/* ---------------------------------------------------- 3. 路由行为 */

console.log('3) 路由注册与请求校验');
let route = null;
host.apply({
  webServer: {
    register(value) {
      route = value;
      return () => {};
    },
  },
  effect(callback) {
    callback();
    return () => {};
  },
  logger: { warn: console.warn },
});
check('注册了 prefix 路由', route !== null && route.kind === 'prefix' && route.path === '/dsh-sidebar-context-menu');

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(text) {
      this.body = text;
    },
  };
}

function makeReq({ method = 'POST', url = '/dsh-sidebar-context-menu/open', remoteAddress = '127.0.0.1', host: hostHeader = '127.0.0.1:3080', origin, body = '' } = {}) {
  const queued = [
    { type: 'data', arg: Buffer.from(body) },
    { type: 'end', arg: undefined },
  ];
  const req = {
    method,
    url,
    socket: { remoteAddress },
    headers: { host: hostHeader, ...(origin === undefined ? {} : { origin }) },
    on(type, handler) {
      const index = queued.findIndex((entry) => entry.type === type);
      if (index >= 0) {
        const [entry] = queued.splice(index, 1);
        handler(entry.arg);
      }
      return req;
    },
    destroy() {},
  };
  return req;
}

async function call(options) {
  const res = makeRes();
  await route.handler(makeReq(options), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* 非 JSON 也无所谓 */
  }
  return { status: res.statusCode, json };
}

check('GET → 405', (await call({ method: 'GET' })).status === 405);
check('非本机 socket → 403', (await call({ remoteAddress: '10.0.0.5' })).status === 403);
check('异源 Origin → 403', (await call({ origin: 'http://evil.example.com' })).status === 403);
check('未知子路径 → 404', (await call({ url: '/dsh-sidebar-context-menu/nope' })).status === 404);
check('非法 target → 400', (await call({ body: JSON.stringify({ target: 'nope', path: 'C:\\x' }) })).status === 400);
check('缺 path → 400', (await call({ body: JSON.stringify({ target: 'vscode' }) })).status === 400);
check('坏 JSON → 400', (await call({ body: 'not-json' })).status === 400);

const okShape = await call({ body: JSON.stringify({ target: 'vscode' }) });
check('错误响应带 { ok: false }', okShape.json !== null && okShape.json.ok === false);

console.log('4) VS Code 启动器探测');
const launcher = host.resolveVscodeLauncher();
check('返回 null 或 { command, shell }', launcher === null || (typeof launcher.command === 'string' && typeof launcher.shell === 'boolean'));
if (launcher) console.log(`       （本机探测到：${launcher.command}）`);

console.log('');
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('ALL PASS');
}
