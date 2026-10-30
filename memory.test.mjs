import test from 'node:test';
import assert from 'node:assert/strict';
import {selectProject,readMemory,sourcePage} from './map.mjs';
test('明确选图、同名不猜、正文不重复、详情单独回查',()=>{
  const projects=[{id:'a',name:'同名'},{id:'b',name:'同名'}];
  assert.throws(()=>selectProject(projects)); assert.throws(()=>selectProject(projects,'同名'));
  assert.equal(selectProject(projects,'b').id,'b');
  const row={project_id:'b',updated_at:'v2',doc:'当前文档',nodes:[{id:'j1',title:'暂定判断',body:'很长的正文',unresolved:true}],edges:[]};
  const value=readMemory('同名',row);
  assert.equal(value.document,row.doc);assert.equal(value.graph.nodes[0].body,undefined);
  assert.equal(readMemory('同名',row,['j1']).nodes[0].body,'很长的正文');
  assert.throws(()=>readMemory('同名',row,['missing']));
  assert.equal(readMemory('同名',{...row,doc:''}).graph.nodes[0].body,'很长的正文');
});
test('来源分段保持完整，旧版明确标记，不允许跨主题续页',()=>{
  const content='来源🙂'.repeat(5000);
  const raw='旧版判断\n来源原文 '+JSON.stringify({v:1,provider:'codex',sessionId:'s',id:'m',role:'user',title:'原会话',ts:1,phase:'commentary',turnStatus:'inProgress',content});
  let page=sourcePage('a',raw),text=page.text;
  assert.ok(page.text.length<=12000);assert.ok(page.hasMore);
  assert.throws(()=>sourcePage('b',raw,page.nextCursor));
  while(page.nextCursor) {page=sourcePage('a',raw,page.nextCursor);text+=page.text;}
  assert.ok(text.includes(content));assert.match(text,/不是完整原文/);
  assert.match(text,/原会话 · user · 1970-01-01T00:00:00.001Z · commentary · inProgress/);
});
