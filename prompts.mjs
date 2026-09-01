/**
 * 提交指引 —— 2026-09-01 写入归一后，规则不再住在客户端。
 *
 * agent 只做搬运：把水位之后的对话原文传给 submit_map_update，
 * 生成（prompt / 解析 / 落文档＋图＋锚）全在 GFT 平台端点（api/map-update）跑——
 * 与网页端同一条管道、同一份规则，永不漂移。
 *
 * （旧 SHARED_RULES / buildUpdatePrompt 副本与 DRIFT_ANCHORS 防漂移判据已删——
 *   "复制就有漂移风险"是本文件自己写下的警告，8-27 起两边规则实际分叉即为实证；
 *   根治=规则单源在平台，防漂移测试随之失去对象。）
 */

export function buildUpdateInstruction(extMarks) {
  const marks = extMarks?.length
    ? extMarks.map(m => `- ${m.id}：上次交到「${m.cursor}」`).join('\n')
    : '（这张图还没吃过外部对话，本场从头传起）';
  return `# 把这场对话的新内容存进用户的思维脉络

你不需要抽取判断、不需要遵守任何格式规则——生成由 GFT 平台完成（与网页端同一条管道）。你只做搬运：

1. 对照下面你自己那条线的水位，把**水位之后**的对话整理为纯文本原文：用户说的话务必完整保留（他的原话就是原料），你的回答保留要点即可，寒暄可略。
2. 调 submit_map_update：raw_text=这段原文；project=图名（必填，写入目标必须显式）；cursor=本次交到哪（日期＋话题＋位置，人话）；agent_id=你这条线的稳定标识（如工作目录名）。
3. 平台返回知情回执（新增了哪些判断、写了多少文档）——原样转告用户。

# 各方水位

${marks}`;
}
