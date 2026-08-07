#!/usr/bin/env node
/**
 * 判据 —— 零网络、零 API、零 token。改 map.mjs / prompts.mjs 前后都跑一遍。
 *
 * 为什么值得写：
 *   ① 「还悬着」的判定出过事（画布判 `unresolved ‖ 问句无出边`，注入只认 `unresolved`
 *      → 图上一片问号、喂给 AI 的却是空的 → AI 只能编）。口径必须钉死。
 *   ② 抽取规则是**从 TS 源复制**过来的，复制就会漂移——最后一组判据逐句比对源文件。
 *
 * 跑：node selftest.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  groupNodes, renderMap, serializePreviousMap, parseTags, mergeIncremental, stripWrapQuotes,
  summarizeLines, humanAge,
} from './map.mjs';
import { DRIFT_ANCHORS, SHARED_RULES, buildUpdateInstruction } from './prompts.mjs';

let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const N = (id, title, extra = {}) => ({ id, title, body: '', order: extra.order ?? 0, ...extra });

console.log('\n【分组口径】');
{
  const nodes = [
    N('a', '差异化不在 AI 输出层', { order: 1 }),
    N('b', '推进要把人推向哪里？', { order: 2 }),                    // 问句 + 无出边 → 悬着
    N('c', '收费用哪种模式？', { order: 3 }),                        // 问句 + 有出边 → 已想通
    N('d', '定价走标准月费', { order: 4 }),
    N('e', '这条我标了没解', { order: 5, unresolved: true }),
    N('f', '推进人格', { order: 6, superseded: true }),
    N('g', '这个方向还成立吗？', { order: 7, superseded: true }),    // 否决 + 问句 → 仍归否决
    N('h', '被收拢的旧节点', { order: 8, condensedInto: 'a' }),
  ];
  const edges = [{ from: 'c', to: 'd' }];
  const g = groupNodes(nodes, edges);

  ok('已收拢节点不出现在任何分组', g.visible.every(n => n.id !== 'h'));
  ok('可见节点数 = 7', g.visible.length === 7);
  ok('问句 + 无出边 → 还悬着', g.open.some(n => n.id === 'b'));
  ok('问句 + 有出边 → 不算悬着（已被后续承接）', !g.open.some(n => n.id === 'c') && g.settled.some(n => n.id === 'c'));
  ok('显式 unresolved → 还悬着', g.open.some(n => n.id === 'e'));
  ok('superseded → 已否决', g.rejected.some(n => n.id === 'f'));
  ok('superseded 压过问句规则', !g.open.some(n => n.id === 'g') && g.rejected.some(n => n.id === 'g'));
  ok('三组互斥且覆盖全部可见节点', g.settled.length + g.open.length + g.rejected.length === g.visible.length);
  ok('按 order 排序', g.visible.map(n => n.id).join('') === 'abcdefg');
  ok('全角问号同样识别', groupNodes([N('x', '这样对吗？')], []).open.length === 1);
  ok('问号后带空格仍识别', groupNodes([N('x', '这样对吗? ')], []).open.length === 1);
  ok('非问句无出边 → 不算悬着', groupNodes([N('x', '一句普通判断')], []).open.length === 0);
}

console.log('\n【给人看的脉络】');
{
  const nodes = [N('a', '判断一', { order: 1, body: '理由若干' }), N('b', '悬着的问题？', { order: 2 })];
  const text = renderMap('测试脉络', groupNodes(nodes, []), []);

  ok('标题含脉络名', text.includes('# 思维脉络：测试脉络'));
  ok('统计正确', text.includes('共 2 条判断，其中 1 条还悬着'));
  ok('有 body 时缩进跟随', text.includes('- 判断一\n  理由若干'));
  // 断言 section 标题而非裸词——用法说明里本来就解释了这三个标签
  ok('空分组不输出该节', !text.includes('## 已否决') && text.includes('## 还悬着'));
  ok('带用法说明（防 AI 改写标题）', text.includes('逐字使用上面的原标题'));
  ok('提示别反复拉（省用户 token）', text.includes('一场会话拉一次'));
  ok('列出其他可读项目', renderMap('甲', groupNodes(nodes, []), [{ name: '乙' }]).includes('另有 1 个项目可读：乙'));
}

console.log('\n【序列化（喂给 agent 的只读旧图）】');
{
  const nodes = [
    N('id-a', '判断一', { order: 1, body: '理由' }),
    N('id-b', '判断二', { order: 2 }),
    N('id-c', '收拢掉的', { order: 3, condensedInto: 'id-a' }),
  ];
  const edges = [
    { from: 'id-a', to: 'id-b' },
    { from: 'id-a', to: 'id-c' },   // 指向已收拢节点 → 不该出现在序列化里
  ];
  const s = serializePreviousMap(nodes, edges);

  ok('别名按顺序 n1/n2', s.text.includes('n1: 判断一 — 理由') && s.text.includes('n2: 判断二'));
  ok('已收拢节点不进序列化', !s.text.includes('收拢掉的'));
  ok('边只保留两端都在的', s.text.includes('n1 -> n2') && !s.text.includes('n3'));
  ok('别名映射可反查', s.aliasToNode.get('n1').id === 'id-a' && s.idToAlias.get('id-b') === 'n2');
  ok('空图不炸', serializePreviousMap([], []).text.includes('（空图）'));
}

console.log('\n【解析 agent 输出的标签】');
{
  const raw = [
    '```xml',
    '<point t="这是草稿,应该被忽略"/>',
    '<node id="m1" title="「说话可外包」" body="按判断权划边界"/>',
    '<node id="m2" title="server 越被动越好"/>',
    '<node id="m2" title="重复 id 应被丢弃"/>',
    '<node id="m3"/>',
    '<edge from="n1" to="m1"/>',
    '<edge from="m1" to="m1"/>',
    '<edge from="n1" to="m1"/>',
    '<edge from="m1" to="m2" turn="true"/>',
    '```',
  ].join('\n');
  const p = parseTags(raw);

  ok('剥掉 markdown 围栏后仍能解析', p.nodes.length === 2);
  ok('成对引号被剥掉', p.nodes[0].title === '说话可外包');
  ok('重复 id 丢弃', p.nodes.filter(n => n.id === 'm2').length === 1);
  ok('缺 title 的 node 丢弃', !p.nodes.some(n => n.id === 'm3'));
  ok('<point/> 草稿被忽略', !JSON.stringify(p.nodes).includes('草稿'));
  ok('自环边丢弃', !p.edges.some(e => e.from === e.to));
  ok('重复边去重', p.edges.filter(e => e.from === 'n1' && e.to === 'm1').length === 1);
  ok('turn 标记保留', p.edges.some(e => e.to === 'm2' && e.turn === true));
  ok('<noop/> 可识别', parseTags('<noop/>').noop === true);
  ok('空输入不炸', parseTags('').nodes.length === 0 && parseTags(undefined).nodes.length === 0);
}

console.log('\n【增量合并（图只生长，不重排）】');
{
  const prev = [N('id-a', '旧判断一', { order: 0 }), N('id-b', '旧判断二', { order: 1 })];
  const prevEdges = [{ id: 'te_old', from: 'id-a', to: 'id-b', type: 'relates' }];
  const parsed = parseTags([
    '<node id="m1" title="新判断一"/>',
    '<node id="m2" title="新判断二"/>',
    '<node id="n1" title="偷改旧节点"/>',
    '<edge from="n2" to="m1"/>',
    '<edge from="m1" to="m2"/>',
    '<edge from="m1" to="n1"/>',
    '<edge from="m2" to="m1"/>',
    '<edge from="nX" to="m2"/>',
  ].join('\n'));
  const r = mergeIncremental(prev, prevEdges, parsed, () => 1000);

  ok('旧节点原样保留', r.nodes.slice(0, 2).every((n, i) => n.id === prev[i].id));
  ok('新节点接在时序尾部', r.nodes[2].order === 2 && r.nodes[3].order === 3);
  ok('新增两条（重输出的旧节点被挡）', r.added.length === 2);
  ok('挡下重输出旧节点并说明原因', r.skipped.some(s => s.includes('重复输出旧节点')));
  ok('旧边原样保留', r.edges[0].id === 'te_old');
  ok('旧→新 的边收下', r.edges.some(e => e.from === 'id-b' && e.to === r.added[0].id));
  ok('新→新 的边收下', r.edges.some(e => e.from === r.added[0].id && e.to === r.added[1].id));
  ok('指向历史的边被挡', r.skipped.some(s => s.includes('指向历史的边')));
  ok('逆时序的边被挡', r.skipped.some(s => s.includes('逆时序')));
  ok('起点不存在的边被挡', r.skipped.some(s => s.includes('边起点不存在')));
  ok('新节点带未读标记（知情的最轻载体）', r.added.every(n => n.unread === true));
  ok('新节点字段齐全（缺字段前端会炸）',
    r.added.every(n => n.id && n.projectId === 'tm_demo' && Array.isArray(n.notes)
      && Array.isArray(n.commits) && n.headCommitId === null && typeof n.createdAt === 'number'));
  ok('新节点带来源标识 source=agent（图面 ⚡ 角标）', r.added.every(n => n.source === 'agent'));
  ok('合并后总数正确', r.nodes.length === 4 && r.addedEdges === 2);

  const empty = mergeIncremental([], [], parseTags('<node id="m1" title="第一条"/>'), () => 1000);
  ok('空图上也能长出第一条', empty.nodes.length === 1 && empty.nodes[0].order === 0);
}

console.log('\n【线的新鲜度（归一：都是"线名+时间"）】');
{
  const H = 3_600_000;
  const now = 10 * H;
  const nodes = [
    { id: 'a', title: '站内早的', createdAt: 1 * H },
    { id: 'b', title: '站内晚的', createdAt: 4 * H },
    { id: 'c', title: 'agent 的', createdAt: 7 * H, source: 'agent' },
    { id: 'd', title: '已收拢的更晚', createdAt: 9 * H, condensedInto: 'a' },
  ];
  const wm = { 'sess-uuid': 'msg-1', 'ext:agent:git-for-thought': '至第40轮' };
  const lines = summarizeLines(nodes, wm);

  ok('两条线各一行', lines.length === 2);
  ok('站内线取自己最晚的（不被 agent 节点污染）', lines[0].label === 'GFT 站内' && lines[0].at === 4 * H);
  ok('外部线带具体线名（来自水位 key）', lines[1].label === '⚡git-for-thought' && lines[1].at === 7 * H);
  ok('已收拢节点不计入新鲜度', !lines.some(l => l.at === 9 * H));
  ok('内部 session 水位 key 不混进线名', !lines.some(l => l.label.includes('sess-uuid')));
  ok('只有 agent 节点却无水位线名 → 兜底标签', summarizeLines([nodes[2]], {})[0].label === '⚡外部 agent');
  ok('空图零行不炸', summarizeLines([], {}).length === 0 && summarizeLines(undefined, undefined).length === 0);
  ok('humanAge 粗粒度正确',
    humanAge(now - 30_000, now) === '刚刚' && humanAge(now - 5 * 60_000, now) === '5 分钟前'
    && humanAge(now - 3 * H, now) === '3 小时前' && humanAge(now - 49 * H, now) === '2 天前');
}

console.log('\n【引号成对才剥】');
{
  ok('成对剥掉', stripWrapQuotes('「判断」') === '判断');
  ok('只有半边不剥（曾把 A提供「B」削成 A提供「B）', stripWrapQuotes('AI重在提供「问题推力」') === 'AI重在提供「问题推力」');
  ok('多层成对逐层剥', stripWrapQuotes('「『判断』」') === '判断');
  ok('空串不炸', stripWrapQuotes('') === '' && stripWrapQuotes(undefined) === '');
}

console.log('\n【更新指令】');
{
  const withMark = buildUpdateInstruction('节点：\nn1: 某判断', [
    { id: 'git-for-thought', cursor: '2026-08-05 至第 40 轮' },
    { id: 'other-line', cursor: '2026-08-04 至第 12 轮' },
  ]);
  const noMark = buildUpdateInstruction('节点：\n（空图）', []);

  ok('带上旧图', withMark.includes('n1: 某判断'));
  ok('多方水位并列且带身份', withMark.includes('[git-for-thought] 2026-08-05 至第 40 轮') && withMark.includes('[other-line]'));
  ok('指示只认自己那条', withMark.includes('认你自己那条'));
  ok('无水位时说明从头看', noMark.includes('从头看起'));
  ok('钉死「to 只能是新节点」', withMark.includes('to 只能是新节点'));
  ok('钉死「只抽用户真说了的」', withMark.includes('只抽**用户真说了的**新判断'));
  ok('给出 noop 出口', withMark.includes('<noop/>'));
  ok('含完整共享规则', withMark.includes(SHARED_RULES));
  ok('指示抽完调 submit 并自报 agent_id', withMark.includes('submit_map_update') && withMark.includes('agent_id'));
  ok('旧签名(单字符串)兼容不炸', buildUpdateInstruction('x', '旧游标').includes('旧游标'));
}

console.log('\n【防漂移：与 TS 源逐句比对】');
{
  // 独立仓后 TS 源不在 ../ 了：GFT_SRC 指向主仓根即可跑全量防漂移（本机开发用）；
  // 不设则跳过（CI/外部环境拿不到私有主仓，属正常）
  const srcRoot = process.env.GFT_SRC || join(dirname(fileURLToPath(import.meta.url)), '..');
  const tsPath = join(srcRoot, 'src', 'service', 'thinkingMapService.ts');
  let ts = null;
  try { ts = readFileSync(tsPath, 'utf8'); } catch { /* 读不到=没主仓可比 */ }

  if (!ts) {
    console.log('  ⏭ 读不到 TS 源（设 GFT_SRC=主仓根路径 可跑全量防漂移），跳过比对');
  } else {
    DRIFT_ANCHORS.forEach(anchor => {
      ok(`规则未漂移：${anchor.slice(0, 22)}…`, ts.includes(anchor) && SHARED_RULES.includes(anchor));
    });
    ok('节点数上限与 TS 一致（NODE_CAP_MAX=12）', /NODE_CAP_MAX\s*=\s*12/.test(ts));
  }
}

console.log(`\n${fail === 0 ? '✅ 全绿' : '❌ 有挂'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
