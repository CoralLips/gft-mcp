#!/usr/bin/env node
// GFT plugin hook：程序级斜杠命令——「产出给人看的」命令在这里拦截直显，零模型、零 token。
//
// 边界（钉死，防糖衣膨胀）：只拦纯查询/程序动作（list / login）。
// 凡是产出要进模型上下文的（link / save）永远走 command 的 AI 流程，不进此表。
//
// PoC 实证（2026-8-7）：hook 收到的 prompt 是用户敲的原文（如 "/gft:list"），
// 不是 command 展开后的内容；block 后该输入不进上下文、不触发模型调用。
// command 文件必须保留——未注册的斜杠命令会被 TUI 拦死（Unknown command），hook 根本收不到。
import { spawn, spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

let raw = '';
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let prompt = '';
  try { prompt = (JSON.parse(raw).prompt || '').trim(); } catch {}
  const m = prompt.match(/^\/gft:(list|login)\s*$/);
  if (!m) process.exit(0); // 非白名单命令：毫秒放行，交还正常流程

  if (m[1] === 'list') {
    // server 约定：日志走 stderr（[gft-mcp] …），名单本体走 stdout
    const r = spawnSync('npx', ['-y', 'gft-mcp@latest', '--check', '--list'], {
      encoding: 'utf8', timeout: 15000, shell: IS_WIN,
    });
    const out = (r.stdout || '').trim();
    const err = (r.stderr || '').trim();
    if (r.status === 0 && out) {
      block(out);
    } else {
      block(`⚠ 列取失败：\n${err || out || '(无输出，可能超时)'}\n\n修复：输入 /gft:login 重新授权`);
    }
  } else {
    // login：要开浏览器等人点，detached 后台跑、立即返回，不占 hook 时限
    const child = spawn('npx', ['-y', 'gft-mcp@latest', '--login-web'], {
      detached: true, stdio: 'ignore', shell: IS_WIN,
    });
    child.unref();
    block('🌐 浏览器即将打开 GFT 授权页——点「授权接入」即可。\n（没弹出？在终端手动跑：npx gft-mcp --login-web）\n完成后输入 /gft:list 验证。');
  }
});

function block(reason) {
  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}
