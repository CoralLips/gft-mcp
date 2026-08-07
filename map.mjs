/**
 * 脉络的读与增量合并 —— 纯函数层，零网络、零 AI。
 *
 * 三块，对应 server 的三件事里的「验」和「供」：
 *   分组   —— 口径必须与画布逐字一致（曾因口径分裂让 AI 只能编造，见 selftest）
 *   序列化 —— 把旧图压成别名文本喂给 agent（对齐 serializePreviousMap）
 *   合并   —— 解析 agent 抽出的标签并增量并入（对齐 parseThinkingMapTags + mergeIncremental）
 *
 * 合并铁律（与 src/service/thinkingMapService.ts 一致）：**图只生长，不重排**。
 * 旧节点旧边工程侧原样保留，agent 碰不到；新边的 to 只能是新节点，历史不许改写。
 */

import { randomUUID } from 'node:crypto';

// ===== 标题清洗 =====

const QUOTE_PAIRS = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]];

/** 剥掉 AI 爱加的首尾成对引号。⚠ 必须**成对**才剥——头尾各剥各的会把 `A提供「B」` 削成 `A提供「B` */
export function stripWrapQuotes(s) {
  let t = (s ?? '').trim();
  for (;;) {
    const pair = QUOTE_PAIRS.find(([l, r]) => t.length > l.length + r.length && t.startsWith(l) && t.endsWith(r));
    if (!pair) break;
    t = t.slice(pair[0].length, t.length - pair[1].length).trim();
  }
  return t;
}

// ===== 分组（口径与画布对齐）=====

/**
 * 「还悬着」的两个来源，与 src/component/focus/ThinkingMapView/index.tsx:796 逐字对齐：
 *   ① 落库 unresolved（用户走过校对、明确标记的）
 *   ② 结构推断：非否决 && 无出边 && 标题以问号收尾（自动生灭）
 * ⚠ 改这里必须同步改画布,否则重蹈「口径分裂」——图上一片问号、喂给 AI 的却是空的。
 */
export function isOpen(node, hasOutEdge) {
  if (node.superseded) return false;
  return !!node.unresolved || (!hasOutEdge.has(node.id) && /[?？]\s*$/.test(node.title ?? ''));
}

export function groupNodes(nodes, edges) {
  const hasOutEdge = new Set((edges ?? []).map(e => e.from));
  // condensedInto 非空 = 已被收拢进上层判断,图面不显示（数据无损,拆开即回）
  const visible = (nodes ?? []).filter(n => !n.condensedInto);
  const byOrder = [...visible].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    visible: byOrder,
    settled: byOrder.filter(n => !n.superseded && !isOpen(n, hasOutEdge)),
    open: byOrder.filter(n => isOpen(n, hasOutEdge)),
    rejected: byOrder.filter(n => n.superseded),
  };
}

// ===== 供：线的新鲜度（归一：一切喂图者都是"线"，同一格式 线名+时间）=====

/**
 * 汇总一张图被哪些线喂过、各自最后喂到什么时候。
 * 数据全从节点聚合（createdAt × source）——不依赖水位的自由文本，两类线天然同构：
 *   本站线：source 缺省的节点 ｜ 外部线：source==='agent' 的节点（线名列表来自水位 ext:agent:* key）
 */
export function summarizeLines(nodes, watermarks) {
  const visible = (nodes ?? []).filter(n => !n.condensedInto);
  const lastChat = visible.reduce((m, n) => (!n.source && n.createdAt > m ? n.createdAt : m), 0);
  const lastAgent = visible.reduce((m, n) => (n.source === 'agent' && n.createdAt > m ? n.createdAt : m), 0);
  const agentNames = Object.keys(watermarks ?? {})
    .filter(k => k.startsWith('ext:agent:'))
    .map(k => k.slice('ext:agent:'.length));
  const lines = [];
  if (lastChat) lines.push({ label: 'GFT 站内', at: lastChat });
  if (lastAgent) lines.push({ label: `⚡${agentNames.length ? agentNames.join('、') : '外部 agent'}`, at: lastAgent });
  return lines;
}

/** 时间 → 人话（相对时间,粗粒度够用） */
export function humanAge(ts, now = Date.now()) {
  const m = Math.floor((now - ts) / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return d <= 30 ? `${d} 天前` : '一个月以上';
}

// ===== 供：给人看的脉络 =====

function renderNode(n) {
  const body = (n.body ?? '').trim();
  return body ? `- ${n.title}\n  ${body.replace(/\n+/g, '\n  ')}` : `- ${n.title}`;
}

export function renderMap(projectName, groups, otherProjects) {
  const { settled, open, rejected, visible } = groups;
  const sections = [
    settled.length ? `## 已想通（${settled.length}）\n${settled.map(renderNode).join('\n')}` : '',
    open.length ? `## 还悬着（${open.length}）\n${open.map(renderNode).join('\n')}` : '',
    rejected.length ? `## 已否决（${rejected.length}）\n${rejected.map(renderNode).join('\n')}` : '',
  ].filter(Boolean);

  const head = `# 思维脉络：${projectName}\n共 ${visible.length} 条判断，其中 ${open.length} 条还悬着。`;
  const note =
    '---\n' +
    '**这是用户在 GFT 里逐条确认过的思考资产，不是 AI 的推测。**\n' +
    '- 「已想通」= 他已经拍板的判断；「还悬着」= 他自己标记的未解问题；「已否决」= 他明确否掉的方向\n' +
    '- 提到其中任何一条时**逐字使用上面的原标题**，不要改写或缩写——他要能认出那是自己写的\n' +
    '- 这份内容一场会话拉一次即可，不必反复调用（读取消耗的是用户自己的 token）';
  const others = otherProjects.length
    ? `\n（另有 ${otherProjects.length} 个项目可读：${otherProjects.map(p => p.name).join('、')}——传 project 参数切换）`
    : '';

  return [head, sections.join('\n\n'), note + others].filter(Boolean).join('\n\n');
}

// ===== 序列化旧图（喂给 agent 做增量的只读上下文）=====

/** 对齐 serializePreviousMap：别名 n1/n2… → 真实节点 */
export function serializePreviousMap(nodes, edges) {
  const aliasToNode = new Map();
  const idToAlias = new Map();
  const visible = (nodes ?? []).filter(n => !n.condensedInto);
  const nodeLines = visible.map((n, i) => {
    const alias = `n${i + 1}`;
    aliasToNode.set(alias, n);
    idToAlias.set(n.id, alias);
    const body = n.body?.trim() ? ` — ${n.body.trim()}` : '';
    return `${alias}: ${stripWrapQuotes(n.title)}${body}`;
  });
  const edgeLines = (edges ?? [])
    .filter(e => idToAlias.has(e.from) && idToAlias.has(e.to))
    .map(e => `${idToAlias.get(e.from)} -> ${idToAlias.get(e.to)}`);
  const text = `节点：\n${nodeLines.join('\n') || '（空图）'}\n\n边：\n${edgeLines.length ? edgeLines.join('\n') : '（无）'}`;
  return { text, aliasToNode, idToAlias, orderedNodes: visible };
}

// ===== 验：解析 agent 输出的标签 =====

/**
 * 确定性解析 <node/> / <edge/> / <noop/>，对齐 parseThinkingMapTags。
 * 白名单：node 必须有 id+title 且 id 不重复；edge 自环丢弃、去重。
 * 存在性与时序合法性留到合并层校验（这里看不到旧图）。
 */
export function parseTags(raw) {
  const text = (raw ?? '').replace(/```(?:xml)?/gi, '');
  const nodes = [];
  const rawEdges = [];
  const seenNodeIds = new Set();
  let noop = false;

  const tagRe = /<(node|edge|point|noop)\s*([^>]*?)\/?>/g;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const attrs = {};
    const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[2])) !== null) attrs[a[1]] = a[2];

    if (m[1] === 'node') {
      const id = (attrs.id ?? '').trim();
      const title = stripWrapQuotes(attrs.title ?? '');
      if (!id || !title || seenNodeIds.has(id)) continue;
      seenNodeIds.add(id);
      nodes.push({ id, title, body: (attrs.body ?? '').trim() });
    } else if (m[1] === 'edge') {
      const from = (attrs.from ?? '').trim();
      const to = (attrs.to ?? '').trim();
      if (!from || !to || from === to) continue;
      rawEdges.push({ from, to, turn: (attrs.turn ?? '').trim() === 'true' });
    } else if (m[1] === 'noop') {
      noop = true;
    }
    // <point/> 是草稿标签,忽略
  }

  const seen = new Set();
  const edges = rawEdges.filter(e => {
    const key = `${e.from}→${e.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { nodes, edges, noop };
}

// ===== 存：增量合并 =====

function newCard(title, body, order, now) {
  return {
    id: randomUUID(),
    projectId: 'tm_demo', // 图内节点一律用哨兵,真实归属看 thinking_maps 行的 project_id
    title,
    body,
    isDone: false,
    order,
    relatedIds: [],
    notes: [],
    commits: [],
    headCommitId: null,
    createdAt: now,
    updatedAt: now,
    unread: true, // 新长出来的挂红点,你点开看过即消——"知情"的最轻载体
    source: 'agent', // 来源标识:图面 ⚡ 角标,与 GFT 站内 chat 长出的节点区分
  };
}

/**
 * 增量合并（对齐 mergeIncremental）。铁律：图只生长和标注，不重排。
 * 返回 { nodes, edges, added, skipped }——added/skipped 供 server 生成知情反馈。
 */
export function mergeIncremental(prevNodes, prevEdges, parsed, nowFn = Date.now) {
  const now = nowFn();
  const serialized = serializePreviousMap(prevNodes, prevEdges);
  const skipped = [];

  // agent 违规重输出旧节点 → 忽略（旧节点不接受改写）
  const fresh = parsed.nodes.filter(n => {
    if (serialized.aliasToNode.has(n.id)) {
      skipped.push(`重复输出旧节点 ${n.id}`);
      return false;
    }
    return true;
  });

  // 全局时序位次：旧节点在前（按现有顺序），新节点接在后
  const aliasToRealId = new Map();
  const aliasSeq = new Map();
  serialized.orderedNodes.forEach((n, i) => {
    const alias = serialized.idToAlias.get(n.id);
    if (alias) { aliasToRealId.set(alias, n.id); aliasSeq.set(alias, i); }
  });

  const maxOrder = (prevNodes ?? []).reduce((m, n) => Math.max(m, n.order ?? 0), -1);
  const nodes = [...(prevNodes ?? [])];
  const added = [];
  fresh.forEach((n, i) => {
    const card = newCard(n.title, n.body, maxOrder + 1 + i, now + i);
    aliasToRealId.set(n.id, card.id);
    aliasSeq.set(n.id, serialized.orderedNodes.length + i);
    nodes.push(card);
    added.push(card);
  });

  const freshAliases = new Set(fresh.map(n => n.id));
  const edges = [...(prevEdges ?? [])];
  const edgeKeys = new Set(edges.map(e => `${e.from}→${e.to}`));
  let addedEdges = 0;
  parsed.edges.forEach((e, i) => {
    if (!freshAliases.has(e.to)) { skipped.push(`指向历史的边 ${e.from}→${e.to}（to 只能是新节点）`); return; }
    const fs = aliasSeq.get(e.from);
    const ts = aliasSeq.get(e.to);
    if (fs === undefined) { skipped.push(`边起点不存在 ${e.from}`); return; }
    if (ts === undefined || fs >= ts) { skipped.push(`逆时序的边 ${e.from}→${e.to}`); return; }
    const from = aliasToRealId.get(e.from);
    const to = aliasToRealId.get(e.to);
    const key = `${from}→${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: `te_${now}_${i}`, from, to, type: 'relates', ...(e.turn ? { turn: true } : {}) });
    addedEdges++;
  });

  return { nodes, edges, added, addedEdges, skipped };
}
