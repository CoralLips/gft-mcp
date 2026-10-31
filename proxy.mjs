// Node 的 fetch 既不读系统代理，也不读 HTTPS_PROXY：开着 VPN（系统代理）时直连会被重置，
// 表现成 "fetch failed"。启动时找出代理并让所有出站请求走它；本机地址与 NO_PROXY 始终直连。
import { execFileSync } from 'node:child_process';
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';

const httpUrl = value => {
  if (!value) return undefined;
  const url = /^[a-z][\w+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  return /^https?:\/\//i.test(url) ? url : undefined; // SOCKS 不支持，不接管
};

/** Windows / macOS 的系统代理（VPN 客户端一般设在这里）；读不到就返回 undefined。 */
function systemProxy() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      );
      if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(out)) return undefined;
      const server = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
      if (!server) return undefined;
      // "host:port"，或按协议分开的 "http=host:port;https=host:port;socks=host:port"
      const parts = Object.fromEntries(server.split(';').map(p => (p.includes('=') ? p.split('=') : ['all', p])));
      return httpUrl(parts.https || parts.http || parts.all);
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
      const value = key => out.match(new RegExp(`\\b${key} : (\\S+)`))?.[1];
      for (const kind of ['HTTPS', 'HTTP'])
        if (value(`${kind}Enable`) === '1' && value(`${kind}Proxy`))
          return `http://${value(`${kind}Proxy`)}:${value(`${kind}Port`) || 80}`;
    }
  } catch {
    // 没有代理设置可读时照常直连
  }
  return undefined;
}

/** 按目标主机分流：本机与 NO_PROXY 直连，其余走代理。 */
class ProxyRoute extends Dispatcher {
  constructor(proxy, bypass) {
    super();
    this.direct = new Agent();
    this.proxied = new ProxyAgent(proxy);
    this.bypass = bypass;
  }
  dispatch(options, handler) {
    const host = new URL(options.origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (this.bypass(host) ? this.direct : this.proxied).dispatch(options, handler);
  }
  async close() {
    await Promise.all([this.direct.close(), this.proxied.close()]);
  }
  async destroy(error) {
    await Promise.all([this.direct.destroy(error), this.proxied.destroy(error)]);
  }
}

/** 环境变量优先，其次系统代理；返回实际使用的代理地址，没有则不接管。 */
export function useProxy(env = process.env) {
  const configured = httpUrl(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
  const proxy = configured || systemProxy();
  if (!proxy) return null;
  if (!configured) {
    // 从系统设置读到的代理也写进环境变量，子进程（npm、各家 Agent CLI）跟着走
    env.HTTPS_PROXY = env.HTTP_PROXY = proxy;
    env.NO_PROXY ||= 'localhost,127.0.0.1,::1';
  }
  const skip = (env.NO_PROXY || env.no_proxy || '').split(',').map(s => s.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
  const bypass = host =>
    ['localhost', '127.0.0.1', '::1'].includes(host) ||
    skip.some(rule => rule === '*' || host === rule || host.endsWith(`.${rule}`));
  setGlobalDispatcher(new ProxyRoute(proxy, bypass));
  return proxy;
}
