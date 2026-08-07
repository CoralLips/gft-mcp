#!/usr/bin/env node
/**
 * GFT MCP Server — 把你在 GFT 里确认过的思考资产（思维脉络）接给通用 agent。
 *
 * 设计定位（2026-08-04/05）：**说话可以外包，认账必须回流。**
 * 本 server 只做「验 / 存 / 供」三件事，**零 AI 调用、零 GFT token 消耗**——
 * 推理与抽取全部由调用方 agent 用它自己的额度完成，执行的却是 GFT 的规则（prompts.mjs）。
 *
 * 两个 tool：
 *   read_thinking_map   供：读脉络；for_update=true 时连抽取规则和旧图别名一起给
 *   submit_map_update   验+存：解析 agent 抽出的标签 → 校验 → 增量并入 → 落库
 *
 * ⚠ stdio 传输下 stdout 属于 MCP 协议，任何日志必须走 stderr，否则协议流被污染。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { groupNodes, renderMap, serializePreviousMap, parseTags, mergeIncremental, summarizeLines, humanAge } from './map.mjs';
import { buildUpdateInstruction } from './prompts.mjs';

const log = (...args) => console.error('[gft-mcp]', ...args);

/**
 * 外部来源的水位 key 前缀——与 GFT 内部的 { sessionId: lastMessageId } 并存,互不干扰。
 * 带身份位（ext:agent:<agent_id>）：同一张图可能被多个 Claude Code session 喂,
 * 单 key 会互相覆盖进度(A 写到 40 轮,B 一提交就盖掉)——各记各的,读时各认各的。
 */
const EXT_WM_PREFIX = 'ext:agent:';
const extKey = agentId => `${EXT_WM_PREFIX}${(agentId ?? '').trim() || 'default'}`;

// ===== 配置 =====

// 连接信息自己找,不要求用户在 MCP 配置里传:
// server 就躺在仓库里,仓库根的 .env 本来就有(VITE_ 前缀是给 vite 用的,值同源)。
// 环境变量优先——把 mcp/ 单独拷去别处时仍可用。
function loadRepoEnv() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  const out = {};
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*(VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 拷贝出仓库单独用时读不到,退回环境变量 */ }
  return out;
}

// 内置默认连接（自包含）:anon key 是公开值(本就打进前端 bundle),硬编码无泄密——
// 这让 mcp/ 文件夹拷到任何机器、任何目录都能独立跑,不再依赖仓库 .env。
// 优先级:环境变量 > 仓库 .env(本仓库开发时) > 内置默认(拷出去的用户)。
const DEFAULT_SUPABASE_URL = 'https://ktnlyfdroqdvomepuepa.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0bmx5ZmRyb3Fkdm9tZXB1ZXBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxMDY1MjYsImV4cCI6MjA4NTY4MjUyNn0.CJTOWvyoGTjGXDtGaXpEFCm10r7mbA2DhItZHa13XF0';

const repoEnv = loadRepoEnv();
const SUPABASE_URL = process.env.GFT_SUPABASE_URL || repoEnv.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.GFT_SUPABASE_ANON_KEY || repoEnv.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

// 运行形态自适应(零配置正确):
// - 在 GFT 仓库里跑(读到了 .env)= 开发者 → 授权页默认本地 dev,修复命令用 node <路径>
// - 作为 npm 包跑(路径含 node_modules 或读不到 .env)= 用户 → 授权页默认生产站,修复命令用 npx gft-mcp
const IS_IN_REPO = !!repoEnv.VITE_SUPABASE_URL;
const WEB_BASE = process.env.GFT_WEB_URL || (IS_IN_REPO ? 'http://localhost:3000' : 'https://gitforthought.com');
const SELF_CMD = (() => {
  const self = fileURLToPath(import.meta.url);
  return self.includes('node_modules') || !IS_IN_REPO ? 'npx gft-mcp' : `node "${self}"`;
})();
const SEED_REFRESH_TOKEN = process.env.GFT_REFRESH_TOKEN;

// Supabase 默认开启 refresh token rotation：一个 refresh_token 换过一次就失效，
// 换回来的新 token 必须落盘，否则第二次启动直接废。配置里那个只当**种子**用一次。
const SESSION_FILE = join(homedir(), '.gft-mcp', 'session.json');

function readCachedRefreshToken() {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const { refresh_token, url } = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    return url === SUPABASE_URL ? refresh_token ?? null : null;
  } catch {
    return null;
  }
}

function writeCachedRefreshToken(refresh_token) {
  try {
    mkdirSync(dirname(SESSION_FILE), { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify({ url: SUPABASE_URL, refresh_token }, null, 2), 'utf8');
  } catch (err) {
    log('⚠ session 缓存写入失败（下次启动需重新登录）:', err.message);
  }
}

// ===== 认证 =====

/** 用 refresh_token 换出带身份的客户端；RLS 天然生效，本 server 不做任何越权访问 */
export async function connect() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('缺少 Supabase 配置——确认 mcp/ 还在 GFT 仓库里,且仓库根有 .env');
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const candidates = [readCachedRefreshToken(), SEED_REFRESH_TOKEN].filter(Boolean);
  if (candidates.length === 0) {
    throw new Error(`还没登录——用 shell 跑 \`${SELF_CMD} --login-web\`(打开浏览器点一下授权即可)`);
  }

  // 多进程竞态自愈:Claude Code 会为每个 session 各起一个本 server 进程,共享一份盘上凭证;
  // rotation 下 A 刚用掉换新写盘,B 手里的就成了 Already Used——此时重读盘上(A 写的新 token)再试一次。
  // ⚠ 只在"盘上出现了没试过的新 token"时才重试;家族被吊销时盘上不会变,立即失败——别空转拖慢错误路径。
  let lastErr = null;
  const tried = new Set();
  for (let round = 0; round < 3; round++) {
    const token = round === 0 ? candidates[0] : (readCachedRefreshToken() ?? SEED_REFRESH_TOKEN);
    if (!token || tried.has(token)) {
      if (round === 0) continue;
      break; // 盘上没有新钥匙可试,失败已成定局
    }
    tried.add(token);
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: token });
    if (!error && data?.session) {
      writeCachedRefreshToken(data.session.refresh_token);
      return { supabase, userId: data.session.user.id };
    }
    lastErr = error;
    await new Promise(r => setTimeout(r, 300)); // 给并发进程一拍时间把新 token 落盘,再读一次
  }
  throw new Error(
    `GFT 登录已失效或尚未登录（${lastErr?.message ?? '无可用凭证'}）。\n` +
    `修复:用 shell 跑 \`${SELF_CMD} --login-web\`(会打开浏览器授权页,点一下「授权接入」即可,密码不经过对话)。\n` +
    `也可以用 login 命令（Claude Code:/gft:login;其他 client:mcp 的 login prompt）。`
  );
}

// ===== 数据访问 =====

/** 取一张图的原始行 + 项目名；projectQuery 为空则取最近更新的那张。
 *  空图（project 已建、还没长过脉络）也可被指名匹配——返回 isNew:true 的合成空行，
 *  首次 submit 落成真行（2026-8-7 用户拍：用户视角"项目已建"，agent 就必须看得见）。 */
async function fetchMapRow(supabase, projectQuery) {
  const [mapsRes, projRes] = await Promise.all([
    supabase.from('thinking_maps')
      .select('project_id, nodes, edges, watermarks, updated_at')
      .order('updated_at', { ascending: false }),
    supabase.from('projects').select('id, name'),
  ]);
  if (mapsRes.error) throw new Error(`读取脉络失败：${mapsRes.error.message}`);
  const maps = mapsRes.data ?? [];
  const projects = projRes.data ?? [];
  const nameOf = id => projects.find(p => p.id === id)?.name ?? '未命名脉络';
  const emptyProjects = () => projects.filter(p => !maps.some(m => m.project_id === p.id));
  const othersOf = keepId => [
    ...maps.filter(m => m.project_id !== keepId).map(m => ({ name: nameOf(m.project_id) })),
    ...emptyProjects().filter(p => p.id !== keepId).map(p => ({ name: `${p.name}（空）` })),
  ];

  if (projectQuery?.trim()) {
    const q = projectQuery.trim().toLowerCase();
    const hit = maps.find(m => nameOf(m.project_id).toLowerCase().includes(q));
    if (hit) return { row: hit, name: nameOf(hit.project_id), others: othersOf(hit.project_id), isNew: false };
    // 图里没有 → 空 project 里找（图还没出生，指名即认）
    const emptyHit = emptyProjects().find(p => p.name.toLowerCase().includes(q));
    if (emptyHit) {
      return {
        row: { project_id: emptyHit.id, nodes: [], edges: [], watermarks: {}, updated_at: null },
        name: emptyHit.name, others: othersOf(emptyHit.id), isNew: true,
      };
    }
    const all = [...maps.map(m => nameOf(m.project_id)), ...emptyProjects().map(p => `${p.name}（空）`)];
    throw new Error(`没有名字含「${projectQuery}」的脉络。可选：${all.join('、')}`);
  }
  if (!maps.length) return null;
  return { row: maps[0], name: nameOf(maps[0].project_id), others: othersOf(maps[0].project_id), isNew: false };
}

const EMPTY_HINT = '你在 GFT 里还没有思维脉络。先去 gitforthought.com 聊一段并生成脉络，再回来。';

/** 轻名单：图名 + 条数 + 各线新鲜度。零节点内容——选图决策用,别拿它代替 read */
async function handleList(supabase) {
  // 以 projects 为主表：空图（刚建的 project、还没长过脉络）也要可见——
  // 用户视角"项目已建"而 agent 看不见=两边对"存在"的定义不同步（2026-8-7 用户拍：不符直觉）
  const [mapsRes, projRes] = await Promise.all([
    supabase.from('thinking_maps')
      .select('project_id, nodes, watermarks, updated_at')
      .order('updated_at', { ascending: false }),
    supabase.from('projects').select('id, name'),
  ]);
  if (mapsRes.error) throw new Error(`读取失败：${mapsRes.error.message}`);
  const maps = mapsRes.data ?? [];
  const projects = projRes.data ?? [];
  if (!maps.length && !projects.length) return EMPTY_HINT;

  const nameOf = id => projects.find(p => p.id === id)?.name ?? '未命名脉络';
  const empties = projects.filter(p => !maps.some(m => m.project_id === p.id));

  const rows = maps.map((m, i) => {
    const count = (m.nodes ?? []).filter(n => !n.condensedInto).length;
    const lines = summarizeLines(m.nodes, m.watermarks)
      .map(l => `${l.label} ${humanAge(l.at)}`).join(' · ');
    return `${i + 1}. ${nameOf(m.project_id)} — ${count} 条${lines ? ` · ${lines}` : ''}`;
  });
  const emptyRows = empties.map((p, i) =>
    `${maps.length + i + 1}. ${p.name} — 空 · 还没长过脉络（可直接链接，首次存判断时自动建图）`);
  return [
    `你的思维脉络（${maps.length + empties.length} 张${empties.length ? `，其中 ${empties.length} 张空` : ''}）：`,
    ...rows,
    ...emptyRows,
    '',
    '要用哪张：read_thinking_map(project=图名) 把它带进本场（即「链接」）。',
  ].join('\n');
}

async function handleRead(supabase, { project, for_update }) {
  const found = await fetchMapRow(supabase, project);
  if (!found) return EMPTY_HINT;

  const { row, name, others } = found;
  const newborn = found.isNew
    ? `（「${name}」还是一张空图——直接开聊即可；之后 submit_map_update 首次提交会自动建图。）\n\n`
    : '';
  const readable = newborn + renderMap(name, groupNodes(row.nodes, row.edges), others);
  if (!for_update) return readable;

  // 更新模式：额外给别名映射 + GFT 的抽取规则 + 各方水位（带身份,agent 认自己的那条）
  const serialized = serializePreviousMap(row.nodes, row.edges);
  const extMarks = Object.entries(row.watermarks ?? {})
    .filter(([k]) => k.startsWith(EXT_WM_PREFIX))
    .map(([k, v]) => ({ id: k.slice(EXT_WM_PREFIX.length), cursor: v }));
  return `${readable}\n\n${'='.repeat(48)}\n${buildUpdateInstruction(serialized.text, extMarks)}`;
}

async function handleSubmit(supabase, { project, tags, cursor, agent_id }) {
  if (!tags?.trim()) throw new Error('tags 是空的——先调 read_thinking_map(for_update=true) 拿规则,按规则抽完再提交');
  const found = await fetchMapRow(supabase, project);
  if (!found) return EMPTY_HINT;

  const { row, name } = found;
  const parsed = parseTags(tags);
  if (parsed.noop && parsed.nodes.length === 0) return `「${name}」没有需要补充的新判断（本次记为 noop）。`;
  if (parsed.nodes.length === 0) {
    throw new Error('没解析出任何 <node/>。检查格式：<node id="m1" title="..." body="..."/>，一行一个。');
  }

  const merged = mergeIncremental(row.nodes, row.edges, parsed);
  const watermarks = { ...(row.watermarks ?? {}) };
  if (cursor?.trim()) watermarks[extKey(agent_id)] = cursor.trim();

  const payload = {
    nodes: merged.nodes, edges: merged.edges, watermarks,
    updated_at: new Date().toISOString(),
  };
  // 空图首次提交=建行（insert）；已有图=增量更新
  const { error } = found.isNew
    ? await supabase.from('thinking_maps').insert({ project_id: row.project_id, ...payload })
    : await supabase.from('thinking_maps').update(payload).eq('project_id', row.project_id);
  if (error) throw new Error(`写回失败：${error.message}`);

  // 返回值是**给用户看的**：写了什么必须当场说清,否则等于偷偷改他的东西
  const lines = [
    `✅ 已并入「${name}」：新增 ${merged.added.length} 条判断、${merged.addedEdges} 条连线。`,
    ...merged.added.map(n => `  + ${n.title}`),
  ];
  if (merged.skipped.length) {
    lines.push('', '以下被规则挡下（图只生长、不改写历史）：', ...merged.skipped.map(s => `  ⏭ ${s}`));
  }
  lines.push('', `图上现有 ${merged.nodes.filter(n => !n.condensedInto).length} 条判断。新节点带未读标记,去 GFT 点开即消；不认同就直接删。`);
  return lines.join('\n');
}

// ===== MCP =====

const TOOLS = [
  {
    name: 'list_thinking_maps',
    description:
      '列出用户在 GFT 的全部思维脉络：图名、判断条数、各线新鲜度（哪条线最后什么时候喂过图）。\n' +
      '什么时候调用：本场还没链接任何脉络、需要帮用户选图时；或用户问"我有哪些脉络"。\n' +
      '轻查询,不含节点内容——选定后用 read_thinking_map 读取。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_thinking_map',
    description:
      '读取用户在 GFT（gitforthought.com）里逐条确认过的思考资产——他的「思维脉络」：' +
      '已经想通的判断、还悬着的问题、已经否决的方向。\n' +
      '什么时候调用：用户提到他之前的判断/想法/正在纠结的问题时；' +
      '或你要给出建议、而这个建议应该建立在他已有的思考之上时；或他直接说「读一下我的脉络」时。\n' +
      '一场会话拉一次即可——内容不会在对话中途改变，反复调用只是浪费用户的 token。\n' +
      '选图：本场聊过哪张就继续用哪张；语境不明且用户没指名时，把返回里列出的可选项目报给用户挑，' +
      '**不要赌"最近更新的那张"**——那可能是用户在别的 session 里喂的图。\n' +
      '若用户要把这场对话的新判断存进脉络，用 for_update=true 再调一次：' +
      '会额外返回抽取规则和旧图别名，按那份规则抽完再调 submit_map_update。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '按项目名模糊匹配指定读哪张脉络。不传 = 最近更新的那张（多数情况不用传）。' },
        for_update: { type: 'boolean', description: '要往脉络里补新判断时传 true，会附带抽取规则与旧图别名。默认 false。' },
      },
    },
  },
  {
    name: 'submit_map_update',
    description:
      '把这场对话里长出来的新判断增量并入用户的思维脉络。\n' +
      '**必须先调 read_thinking_map(for_update=true)**，拿到抽取规则和旧图别名，' +
      '按那份规则抽出 <node/> / <edge/> 标签后，原样传进 tags。\n' +
      '规则由 GFT 定，你只出算力：只抽用户真说了的判断，你自己的分析除非他明确接住否则不上图；' +
      '旧节点一律不重输出；没有新东西就传 <noop/>。',
    inputSchema: {
      type: 'object',
      properties: {
        tags: {
          type: 'string',
          description: '按规则抽出的标签原文，一行一个，如：<node id="m1" title="..." body="..."/> 与 <edge from="n2" to="m1"/>。没有新东西时传 <noop/>。',
        },
        cursor: {
          type: 'string',
          description: '本次抽到哪的标记，下次接着走。例："2026-08-05 关于 MCP 外接的讨论，至第 40 轮"。',
        },
        agent_id: {
          type: 'string',
          description: '你这条对话线的稳定标识（如工作目录名或话题名）。同一张图可能被多个 session 喂,水位按此分开记,别省略。',
        },
        project: { type: 'string', description: '写进哪张脉络，同 read_thinking_map。不传 = 最近更新的那张。' },
      },
      required: ['tags'],
    },
  },
];

// ===== MCP prompts:协议级命令,随 server 走 —— 支持 prompts 的任何 client 自动获得,
// 不必在每家 agent 各写一份命令文件(Claude Code 的 ~/.claude/commands/gft/ 是本机短名,两者并存)=====

const PROMPTS = [
  {
    name: 'list',
    description: '列出 GFT 思维脉络（名字·条数·各线新鲜度·本场链接状态）',
    text:
      '列出用户的 GFT 思维脉络：调 list_thinking_maps,原样呈现返回列表;' +
      '末尾补一行本场链接状态(本场读/喂过哪张=已链接,否则提示可链接)。' +
      '不要顺手读任何一张图的全文——这一步只出名单。',
  },
  {
    name: 'link',
    description: '把当前对话链接到一张思维脉络（认领 + 注入一步完成）',
    args: [{ name: 'map', description: '图名(可模糊匹配);不传则先列名单让用户挑', required: false }],
    text: mapArg =>
      `把本场对话链接到 GFT 思维脉络${mapArg ? `「${mapArg}」` : ''}：` +
      `${mapArg ? '调 read_thinking_map(project=该名)。' : '先调 list_thinking_maps 列名单让用户挑(回序号或名字),再读。'}` +
      '读到的图即本场「白盒上下文」,之后引用其中判断须逐字用原标题;' +
      '报一句确认(图名/N 条/M 条悬着,提示说「存一下」可存回)。链接只记在本场对话里,一场一张,换图重跑本命令。',
  },
  {
    name: 'save',
    description: '把本场对话的新判断增量存回已链接的思维脉络',
    text:
      '把本场新判断存回 GFT:①确认本场链接的图(读/喂过哪张就是哪张;没有则先走 link 流程选图)。' +
      '②调 read_thinking_map(project=图名, for_update=true) 拿旧图别名+抽取规则+各线水位。' +
      '③按规则抽取——只抽用户真说了的新判断,对照自己那条线的水位只看其后的对话。' +
      '④调 submit_map_update(tags=标签,无新东西传 <noop/>; cursor=本次抽到哪; agent_id=当前工作目录名)。' +
      '⑤把知情回执原样告诉用户。',
  },
  {
    name: 'login',
    description: 'GFT 登录/修复——发起网页授权,浏览器点一下完成',
    text:
      '检查 GFT 凭证:任调一个 tool(如 list_thinking_maps),成功=凭证正常,把名单顺带给用户。' +
      `失败提示登录失效时:用 shell 跑 \`${SELF_CMD} --login-web\`(非交互,会自动开浏览器到 GFT 授权页),` +
      '同时告诉用户「浏览器已打开授权页,点一下授权接入即可」。输出 ✅ 后复验并把名单报给用户。' +
      `无 shell 能力的环境:让用户开独立终端跑 \`${SELF_CMD} --login\`(交互输邮箱密码)。绝不索要密码。`,
  },
];

async function main() {
  const server = new Server({ name: 'gft', version: '0.2.0' }, { capabilities: { tools: {}, prompts: {} } });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(p => ({
      name: p.name,
      description: p.description,
      ...(p.args ? { arguments: p.args } : {}),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async req => {
    const p = PROMPTS.find(x => x.name === req.params.name);
    if (!p) throw new Error(`未知命令：${req.params.name}`);
    const text = typeof p.text === 'function' ? p.text(req.params.arguments?.map) : p.text;
    return {
      description: p.description,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  });

  // 连接推迟到首次调用：启动阶段失败会让 client 直接判定 server 挂掉，
  // 而凭证过期是常态——留到调用时报错，用户能在对话里看见原因并去续。
  let session = null;
  const ensure = async () => (session ??= await connect());

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const args = req.params.arguments ?? {};
    try {
      const { supabase } = await ensure();
      let text;
      if (req.params.name === 'list_thinking_maps') text = await handleList(supabase);
      else if (req.params.name === 'read_thinking_map') text = await handleRead(supabase, args);
      else if (req.params.name === 'submit_map_update') text = await handleSubmit(supabase, args);
      else throw new Error(`未知工具：${req.params.name}`);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      session = null; // 失败后丢弃会话，下次调用重连（凭证续过就能自愈）
      return { content: [{ type: 'text', text: `⚠ ${err.message}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  log('已启动（stdio）');
}

// ===== 命令行入口 =====

/** 交互式提问；secret=true 时输入不回显 */
function ask(question, secret = false) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (secret) rl._writeToOutput = str => { if (str.includes(question)) rl.output.write(str); };
    rl.question(question, answer => {
      if (secret) rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * 网页授权登录（推荐,gh auth login --web 同款）——非交互,AI 也能直接发起:
 *   起一个一次性本地回调端口 → 打开浏览器到 GFT 设置页 → 用户点「授权接入」→
 *   页面调 /api/agent-token 派生 token_hash POST 回来 → verifyOtp 换出**独立凭证链**落盘。
 * 密码不经过任何对话/终端;浏览器登录态不受影响(链是独立派生的,不是让渡)。
 */
async function loginWeb() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('读不到 Supabase 配置');
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { srv.close(); reject(new Error('等待授权超时(3 分钟)——浏览器里点「授权接入」了吗?')); }, 180_000);

    const srv = createServer((req, res) => {
      // 浏览器页面(可能是 https)POST 到 127.0.0.1:CORS + Private Network Access 预检都放行
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST' || req.url !== '/callback') { res.writeHead(404); res.end(); return; }
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        void (async () => {
          try {
            const { token_hash } = JSON.parse(body || '{}');
            if (!token_hash) throw new Error('回调缺少 token_hash');
            // magiclink 的 hash 用 email 类型核验;两种 GoTrue 版本写法都试
            let session = null;
            for (const type of ['magiclink', 'email']) {
              const { data, error } = await supabase.auth.verifyOtp({ token_hash, type });
              if (!error && data?.session) { session = data.session; break; }
              if (type === 'email' && error) throw new Error(`凭证核验失败:${error.message}`);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            clearTimeout(timer);
            srv.close();
            resolve(session);
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
            clearTimeout(timer);
            srv.close();
            reject(err);
          }
        })();
      });
    });

    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const url = `${WEB_BASE}/connect-agent?port=${port}`;
      log(`回调端口 ${port} 已就绪,打开浏览器授权页…`);
      log(`(没自动打开就手动访问:${url})`);
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 手动打开兜底 */ }
    });
  });

  writeCachedRefreshToken(result.refresh_token);
  log('✅ 授权成功,独立凭证已落盘', SESSION_FILE);
  const text = await handleRead(await connect().then(c => c.supabase), {}).catch(() => null);
  if (text) log(`✅ 验证可读(${text.length} 字符)`);
}

/**
 * 一次性登录 —— 换出 refresh_token 落盘，此后 MCP 配置里**不需要任何凭证**。
 * 凭证进配置文件既麻烦又容易被误提交,所以宁可多这一步。
 */
async function login() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('读不到 Supabase 配置——确认 mcp/ 还在 GFT 仓库里,且仓库根有 .env');
  }
  console.error('登录 GFT（凭证只落在本机 ~/.gft-mcp/session.json,不进 MCP 配置）\n');
  const email = await ask('邮箱: ');
  const password = await ask('密码: ', true);
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data?.session) throw new Error(`登录失败：${error?.message ?? '未拿到会话'}`);
  writeCachedRefreshToken(data.session.refresh_token);
  log('✅ 登录成功,凭证已存到', SESSION_FILE);
  const text = await handleRead(supabase, {});
  log(text === EMPTY_HINT ? '⚠ 但你还没有思维脉络' : `✅ 能读到脉络（${text.length} 字符）`);
}

/** --check：绕开 MCP 协议直接跑，用于自测。--check <项目名> [--for-update] ｜ --check --list */
async function check() {
  log('检查配置…');
  const { supabase, userId } = await connect();
  log('✅ 登录成功，user:', userId);
  if (process.argv.includes('--list')) {
    console.log(await handleList(supabase));
    return;
  }
  const project = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
  const forUpdate = process.argv.includes('--for-update');
  const text = await handleRead(supabase, { project, for_update: forUpdate });
  log(`✅ 读取成功，${text.length} 字符\n`);
  console.log(text);
}

/** --submit <项目名> <标签文件> [cursor] [agent_id]：命令行提交,用于端到端自测 */
async function submitCli() {
  const { supabase } = await connect();
  const project = process.argv[3];
  const tags = readFileSync(process.argv[4], 'utf8');
  const cursor = process.argv[5];
  const agent_id = process.argv[6];
  console.log(await handleSubmit(supabase, { project, tags, cursor, agent_id }));
}

// ===== CLI 子命令(零 AI 直通道)=====
// list/read/login 是纯程序逻辑,走 AI 纯浪费 token+延迟——CLI 是所有 agent 生态的最大公约数:
// 有终端就能跑;Claude Code 里 `! npx gft-mcp list` 的输出直接进对话上下文(= 零 AI 完成注入)。
// save 不设子命令:抽取本体就是 AI 的工作,那不是开销。

/** gft-mcp list —— 瞬回脉络名单(零 AI) */
async function cliList() {
  const { supabase } = await connect();
  console.log(await handleList(supabase));
}

/** gft-mcp read [图名] —— 输出脉络全文;在 Claude Code 里用 `!` 前缀跑 = 零 AI 把图带进对话 */
async function cliRead() {
  const { supabase } = await connect();
  const project = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
  console.log(await handleRead(supabase, { project, for_update: process.argv.includes('--for-update') }));
}

/** gft-mcp save —— 无法纯程序化,指路 */
function cliSaveHint() {
  console.log('「存一下」需要 AI 从对话里抽取判断——这是模型的工作,没有零 AI 通道。\n对你的 agent 说「存一下」或用 save 命令(/gft:save)即可。');
  return Promise.resolve();
}

// 只在被直接执行时启动;被 import 时(自测)不自启,否则测试脚本会挂起在 stdio 上
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  const cmd = process.argv[2];
  const run = cmd === 'list' ? cliList
    : cmd === 'read' ? cliRead
    : cmd === 'save' ? cliSaveHint
    : cmd === 'login' ? (process.argv.includes('--password') ? login : loginWeb)
    // 旧 flag 形态全部保留兼容(文档/命令文件/错误文案历史引用)
    : process.argv.includes('--login-web') ? loginWeb
    : process.argv.includes('--login') ? login
    : process.argv.includes('--check') ? check
    : process.argv.includes('--submit') ? submitCli
    : main;
  run().catch(err => {
    log('❌', err.message);
    process.exit(1);
  });
}
