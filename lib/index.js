/**
 * dsh-sidebar-context-menu — 宿主半边（host half）。
 *
 * 只做一件事：提供 POST /dsh-sidebar-context-menu/open 路由，让浏览器端能请宿主
 * 用系统命令打开路径。浏览器自己做不到「打开资源管理器」，自定义协议也只能靠宿主
 * 转交，所以这一小块必须放在 host。
 *
 * 请求体：{ target: 'vscode' | 'explorer', path: '<绝对目录路径>' }
 *   - explorer → explorer.exe <path>  （Windows；目录以资源管理器打开）
 *   - vscode   → 优先 `code --new-window <path>`（新窗口，不会顶掉当前窗口）；
 *                找不到 code CLI 时退回 rundll32 FileProtocolHandler vscode://file/<path>
 * 其它平台用 open / xdg-open，方便以后在 mac/linux 上用。
 *
 * 注意：spawn 里**不要**加 windowsHide —— 那会给子进程 STARTF_USESHOWWINDOW|SW_HIDE，
 * explorer.exe 会真的把窗口建成隐藏的，表现就是「点了没反应」。
 *
 * 安全：只接受 loopback 请求（socket 是 127.0.0.1 且 Host/Origin 同源），并显式
 * 拒绝 http/https 协议，避免变成一个「任意 URL 打开器」。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 路由前缀；客户端半边硬编码同一个值。 */
const ROUTE_PREFIX = '/dsh-sidebar-context-menu';
const ROUTE_OPEN = `${ROUTE_PREFIX}/open`;
/** 请求体上限（只传一个路径，64KB 足够）。 */
const MAX_BODY_BYTES = 64 * 1024;

export const name = 'sidebar-context-menu';
/** cordis 依赖：网页服务器服务（ctx.webServer）。 */
export const inject = ['webServer'];

/* ------------------------------------------------------------------ 工具 */

/** 判断 IPv4 是否落在 127/8。 */
function isIPv4Loopback(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** socket 的 remoteAddress 是否为本机（含 ::1 与 IPv4-mapped）。 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7));
  return isIPv4Loopback(normalized);
}

/** Host 头里的主机名是否为本机（localhost / [::1] / 127/8）。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4Loopback(hostname);
}

/**
 * 请求级信任围栏：socket 必须来自本机、Host 必须是本机名、且跨站请求拒绝。
 * 与 dsh-better-sidebar 的 fence 同构（只保留 loopback 分支）。
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const host = request.headers?.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** 写一个 JSON 响应；handler 自己拥有响应生命周期，所以这里不再交给框架。 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

/** 读取并解析 JSON 请求体（带大小上限）。 */
function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

/**
 * detached 启动一个外部命令，立即返回；失败只吞掉 'error' 事件。
 * 不要设置 windowsHide：SW_HIDE 会让 explorer.exe 的窗口不可见（点了像没反应）。
 * @param command - 可执行文件（.cmd 需要 options.shell）。
 * @param args - 参数数组。
 * @param options - { shell } 走 cmd.exe（Windows 下跑 code.cmd 这类批处理需要）。
 */
function spawnDetached(command, args, options = {}) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: options.shell === true,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 在系统文件管理器里打开一个目录（Windows: explorer.exe）。 */
function revealDirectory(path) {
  switch (process.platform) {
    case 'darwin':
      return { started: spawnDetached('open', [path]), via: 'open' };
    case 'win32':
      return { started: spawnDetached('explorer.exe', [path]), via: 'explorer.exe' };
    default:
      return { started: spawnDetached('xdg-open', [path]), via: 'xdg-open' };
  }
}

/** 缓存 VS Code 启动器探测结果：undefined = 还没探过，null = 没找到。 */
let vscodeLauncherCache;

/**
 * 查注册表里 `vscode://` 协议指向哪个可执行文件。
 * 这是最准的来源：这台机器上 VS Code 装在 `D:\Program Files\Microsoft VS Code`，
 * 而 PATH 里第一个 `code.cmd` 其实是 **Cursor** 的 —— 只按 PATH 找会打开错的编辑器。
 * @returns Code.exe 绝对路径，找不到返回 null。
 */
function readVscodeExeFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const regExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    const result = spawnSync(regExe, ['query', 'HKCR\\vscode\\shell\\open\\command', '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    if (!result || result.status !== 0 || !result.stdout) return null;
    const line = String(result.stdout)
      .split(/\r?\n/)
      .find((candidate) => /REG_(?:EXPAND_)?SZ/i.test(candidate));
    if (!line) return null;
    const match = /REG_(?:EXPAND_)?SZ\s+(?:"([^"]+)"|(\S+))/i.exec(line);
    const exe = match ? match[1] ?? match[2] : null;
    return exe && existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/**
 * 找 VS Code 的启动方式。
 *
 * 为什么不用 `vscode://file/...`：那是「按 VS Code 自己的设置」打开，默认会**顶掉
 * 当前窗口**。我们要的是 `--new-window`：新开一个窗口，不动用户正在用的那个。
 *
 * 探测顺序：
 *   1. 环境变量 DSH_SCM_VSCODE（想改成 Cursor / Windsurf 就指它的 exe/cmd）
 *   2. 注册表 vscode:// 的 Code.exe（最准）
 *   3. 常见安装位置的 bin\code.cmd（LOCALAPPDATA / ProgramFiles）
 *   4. PATH 上的 code（注意可能是 Cursor 的）
 * @returns { command, shell } 或 null。
 */
export function resolveVscodeLauncher() {
  if (vscodeLauncherCache !== undefined) return vscodeLauncherCache;

  const override = process.env.DSH_SCM_VSCODE;
  if (override) {
    vscodeLauncherCache = { command: override, shell: /\.(cmd|bat)$/i.test(override) };
    return vscodeLauncherCache;
  }

  const exe = readVscodeExeFromRegistry();
  if (exe) {
    vscodeLauncherCache = { command: exe, shell: false };
    return vscodeLauncherCache;
  }

  const isWin = process.platform === 'win32';
  if (isWin) {
    const bases = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft VS Code', 'bin'),
      process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'bin'),
    ];
    for (const base of bases) {
      if (!base) continue;
      const candidate = join(base, 'code.cmd');
      if (existsSync(candidate)) {
        vscodeLauncherCache = { command: candidate, shell: true };
        return vscodeLauncherCache;
      }
    }
  }

  const names = isWin ? ['code.cmd', 'code.exe', 'code'] : ['code'];
  const dirs = String(process.env.PATH ?? '').split(isWin ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        vscodeLauncherCache = { command: candidate, shell: isWin };
        return vscodeLauncherCache;
      }
    }
  }

  vscodeLauncherCache = null;
  return vscodeLauncherCache;
}

/** 用 VS Code 打开目录：优先 CLI `--new-window`，最后退回协议处理器。 */
function openInVscode(path) {
  const launcher = resolveVscodeLauncher();
  if (launcher) {
    // --new-window：新开窗口，不占用/顶掉用户当前那个窗口
    return {
      started: spawnDetached(launcher.command, ['--new-window', path], { shell: launcher.shell }),
      via: `vscode-cli ${launcher.command}`,
    };
  }
  return {
    started: openCustomScheme(toVscodeFileUrl(path)),
    via: 'vscode-protocol（可能沿用当前窗口）',
  };
}

/** 把自定义协议 URL 交给系统协议处理器（Windows: rundll32 FileProtocolHandler）。 */
function openCustomScheme(url) {
  switch (process.platform) {
    case 'darwin':
      return spawnDetached('open', [url]);
    case 'win32':
      return spawnDetached('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
    default:
      return spawnDetached('xdg-open', [url]);
  }
}

/**
 * 绝对路径 → vscode://file/<路径>。
 * 逐段 encodeURIComponent（盘符的 `:` 还原），这样空格 / 中文 / `#` 都不会破坏 URL。
 * （导出是为了离线冒烟测试；运行时只有 apply / inject / name 被 cordis 使用。）
 */
export function toVscodeFileUrl(path) {
  const forward = String(path).replace(/\\/g, '/');
  const rooted = forward.startsWith('/') ? forward : `/${forward}`;
  const encoded = rooted
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/');
  return `vscode://file${encoded}`;
}

export { isLoopbackRequest };

/* ------------------------------------------------------------------ 插件 */

/**
 * 注册打开路由。
 * @param ctx - 宿主插件上下文（带 webServer 服务）。
 */
export function apply(ctx) {
  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { ok: false, error: 'forbidden' });
        return;
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.invalid').pathname;
      if (pathname !== ROUTE_OPEN) {
        writeJson(response, 404, { ok: false, error: 'not-found' });
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(request);
      } catch {
        writeJson(response, 400, { ok: false, error: 'bad-request' });
        return;
      }

      const target = payload?.target;
      const rawPath = payload?.path;
      if (target !== 'vscode' && target !== 'explorer') {
        writeJson(response, 400, { ok: false, error: 'bad-target' });
        return;
      }
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        writeJson(response, 400, { ok: false, error: 'path-required' });
        return;
      }

      const opened = target === 'vscode'
        ? openInVscode(rawPath)
        : revealDirectory(rawPath);
      if (!opened.started) {
        writeJson(response, 500, { ok: false, error: 'spawn-failed' });
        return;
      }
      writeJson(response, 200, { ok: true, via: opened.via });
    },
  };

  try {
    ctx.effect(() => ctx.webServer.register(route), 'dsh-sidebar-context-menu: /open route');
  } catch (error) {
    // 注册失败不应该拖垮整个插件树：客户端菜单里的两个「打开」会用不了，其余照常。
    ctx.logger?.warn?.('[dsh-sidebar-context-menu] route registration failed:', error);
  }
}
