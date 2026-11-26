import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,content,interaction,GUILD,OTHER_GUILD,HOST,OWNER,MANAGER,actor } from './helpers.js';
import { handler } from '../src/interactions.js';

const values={title:'새 이벤트',description:'새 안내',durationMinutes:60,claimMinutes:10,winners:1};
const fields={title:values.title,description:values.description,duration:'60',claim:'10',winners:'1'};
const buttons=view=>view.components.flatMap(row=>row.toJSON().components).map(c=>c.custom_id);
function setup(t){const f=fixture(t,undefined,{productionLimits:true});const id=f.engine.create(GUILD,HOST,{...values,title:'기존 초안'});f.engine.setProductInfo(GUILD,HOST,id,1,'기존 상품',false);f.engine.setPrize(GUILD,HOST,id,1,content('OLD-SECRET'));f.store.run("INSERT INTO draft_steps(event_id,step,slot) VALUES (?,'items',1)",id);return {...f,id,handle:handler(f.engine,f.transport)};}
function snapshot(f){return Object.fromEntries(['events','prizes','draft_steps','draft_activity','prize_uploads','jobs','audit'].map(table=>[table,f.store.all(`SELECT * FROM ${table}`)]));}

test('한도 화면은 이어쓰기와 교체를 제공하고 입력창을 닫으면 유지하며 제출 때만 원자적으로 교체한다',async t=>{
  const f=setup(t),before=snapshot(f);
  for(const i of [interaction(HOST,'ui:create'),interaction(HOST,'form:create',fields,'modal')]){await f.handle(i);assert.ok(buttons(i.replies[0]).includes(`flow:replace:${f.id}:0`));}
  const choose=interaction(HOST,`flow:replace:${f.id}:0`);await f.handle(choose);assert.ok(buttons(choose.replies[0]).includes(`flow:replacecustom:${f.id}`));
  const open=interaction(HOST,`flow:replacecustom:${f.id}`);await f.handle(open);const form=open.modal.toJSON();assert.equal(form.custom_id,`form:replacecreate:${f.id}`);assert.equal(form.components.length,5);assert.match(JSON.stringify(form),/기존 초안.*취소/);assert.deepEqual(snapshot(f),before);
  f.advance(60000);const submit=interaction(HOST,form.custom_id,fields,'modal');await f.handle(submit);
  const drafts=f.store.all("SELECT * FROM events WHERE status='DRAFT'");assert.equal(drafts.length,1);assert.notEqual(drafts[0].id,f.id);assert.equal(drafts[0].title,values.title);assert.equal(f.store.event(f.id).status,'CANCELLED');
  const old=f.store.get('SELECT secret,name,status FROM prizes WHERE event_id=?',f.id);assert.equal(old.secret,null);assert.equal(old.name,null);assert.equal(old.status,'EXHAUSTED');assert.equal(f.store.get('SELECT event_id FROM draft_steps WHERE event_id=?',f.id),undefined);assert.equal(f.store.get('SELECT event_id FROM draft_activity WHERE event_id=?',f.id),undefined);
  assert.equal(f.store.get("SELECT status FROM jobs WHERE kind='hostCreated' AND ref_id=?",f.id).status,'DONE');assert.equal(f.store.get("SELECT id FROM jobs WHERE kind='closed' AND ref_id=?",f.id),undefined);assert.ok(f.store.get("SELECT id FROM audit WHERE action='DRAFT_REPLACED' AND event_id=?",f.id));assert.equal(f.store.get('SELECT count(*) n FROM events').n,2);
  await f.handle(interaction(HOST,form.custom_id,fields,'modal'));assert.equal(f.store.get('SELECT count(*) n FROM events').n,2);
});

test('교체의 입력 오류·쿨다운·하루 횟수·주최 제한은 기존 상품과 초안 전체를 보존한다',t=>{
  const f=setup(t);let before=snapshot(f);
  assert.throws(()=>f.engine.replaceDraft(GUILD,HOST,f.id,{...values,title:''}),/이벤트명/);assert.deepEqual(snapshot(f),before);
  assert.throws(()=>f.engine.replaceDraft(GUILD,HOST,f.id,values),/간격/);assert.deepEqual(snapshot(f),before);f.advance(60000);
  f.engine.setApplicationLimits(GUILD,OWNER,{daily_limit:1});assert.throws(()=>f.engine.replaceDraft(GUILD,HOST,f.id,values),/24시간/);assert.deepEqual(snapshot(f),before);
  f.engine.setApplicationLimits(GUILD,OWNER,{daily_limit:5});f.engine.restrictHost(GUILD,OWNER,HOST.userId,true,'검사');before=snapshot(f);assert.throws(()=>f.engine.replaceDraft(GUILD,HOST,f.id,values),/주최가 제한/);assert.deepEqual(snapshot(f),before);
});

test('새 상품 자리 기록 실패는 기존 초안 삭제와 감사·알림 변경까지 모두 롤백한다',t=>{
  const f=setup(t);f.advance(60000);const before=snapshot(f),run=f.store.run.bind(f.store);
  f.store.run=(sql,...args)=>{if(sql.startsWith('INSERT INTO prizes')&&args[0]!==f.id)throw new Error('new-slot-write-failed');return run(sql,...args);};
  assert.throws(()=>f.engine.replaceDraft(GUILD,HOST,f.id,values),/new-slot-write-failed/);f.store.run=run;assert.deepEqual(snapshot(f),before);
});

test('관리자·다른 사용자·다른 서버 또는 승인 대기 상태의 초안 교체는 거절한다',async t=>{
  const f=setup(t);f.advance(60000);f.add(actor(88));
  for(const a of [OWNER,MANAGER,actor(88)]){const before=snapshot(f);assert.throws(()=>f.engine.replaceDraft(GUILD,a,f.id,values));assert.deepEqual(snapshot(f),before);const i=interaction(a,`flow:replacecustom:${f.id}`);await f.handle(i);assert.equal(i.modal,undefined);}
  f.engine.store.guild(OTHER_GUILD);assert.throws(()=>f.engine.replaceDraft(OTHER_GUILD,HOST,f.id,values));
  f.engine.submit(GUILD,HOST,f.id);const before=snapshot(f);assert.throws(()=>f.engine.replaceDraft(GUILD,HOST,f.id,values),/초안/);assert.deepEqual(snapshot(f),before);
});

test('교체는 템플릿도 선택할 수 있고 제출 전에 중지되면 원본을 보존한다',async t=>{
  const f=setup(t),tid=f.engine.createTemplate(GUILD,OWNER,'새 템플릿','템플릿 문구');f.engine.updateTemplate(GUILD,OWNER,tid,{proof_instructions:'신규 인증 안내',enabled:true});f.advance(60000);
  const i=interaction(HOST,`flow:replacetemplate:${f.id}`,{values:[tid]},'select');await f.handle(i);assert.equal(i.modal.toJSON().custom_id,`form:replacetemplate:${f.id}:${tid}`);assert.equal(i.modal.toJSON().components.length,5);
  f.engine.updateTemplate(GUILD,OWNER,tid,{enabled:false});const before=snapshot(f);await f.handle(interaction(HOST,i.modal.toJSON().custom_id,fields,'modal'));assert.deepEqual(snapshot(f),before);
  f.engine.updateTemplate(GUILD,OWNER,tid,{enabled:true});await f.handle(interaction(HOST,i.modal.toJSON().custom_id,fields,'modal'));const e=f.store.get("SELECT * FROM events WHERE status='DRAFT'");assert.notEqual(e.id,f.id);assert.equal(e.description,'템플릿 문구');assert.equal(e.proof_required,1);assert.equal(e.proof_instructions,'신규 인증 안내');assert.equal(f.store.get('SELECT template_id FROM draft_steps WHERE event_id=?',e.id).template_id,tid);
});

test('미게시 초안·승인 대기를 취소하면 공개 종료 알림을 만들지 않고 과거 대기 알림도 보내지 않는다',async t=>{
  const f=fixture(t),one=await f.event({start:false}),two=await f.event({start:false});f.engine.submit(GUILD,HOST,two);await f.engine.processJobs();
  for(const id of [one,two]){f.engine.cancel(GUILD,HOST,id);assert.equal(f.store.get("SELECT id FROM jobs WHERE kind='closed' AND ref_id=?",id),undefined);f.store.queue('closed',id,f.now());}
  f.store.run("UPDATE jobs SET status='UNKNOWN' WHERE kind='closed' AND ref_id=?",one);await f.engine.processJobs();
  for(const id of [one,two]){assert.equal(f.notifications.has(`closed:${id}`),false);assert.equal(f.store.get("SELECT error_code FROM jobs WHERE kind='closed' AND ref_id=?",id).error_code,'UNPUBLISHED_EVENT');}
  const published=await f.event();f.engine.cancel(GUILD,HOST,published);await f.engine.processJobs();assert.equal(f.notifications.has(`closed:${published}`),true);
});

test('게시 응답이 불명인 상태에서 취소해도 실제 원본을 찾은 후에만 종료 안내를 보낸다',async t=>{
  const f=fixture(t),eid=await f.event({start:false});f.engine.submit(GUILD,HOST,eid);await f.engine.tick();f.engine.approveEvent(GUILD,MANAGER,eid);f.transport.notifyBehavior='unknown';await f.engine.processJobs();
  assert.equal(f.store.get("SELECT status FROM jobs WHERE id=?",`start:${eid}`).status,'UNKNOWN');f.engine.cancel(GUILD,HOST,eid);assert.equal(f.store.get("SELECT id FROM jobs WHERE kind='closed' AND ref_id=?",eid),undefined);
  f.advance(60000);f.transport.notifyBehavior='success';await f.engine.processJobs();assert.ok(f.store.event(eid).public_message_id);await f.engine.processJobs();assert.equal(f.notifications.has(`closed:${eid}`),true);
});
