import test from 'node:test';
import assert from 'node:assert/strict';
import {selectProject,readMemory} from './map.mjs';
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
