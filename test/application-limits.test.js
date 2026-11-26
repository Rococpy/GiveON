import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,actor,content,interaction,GUILD,OTHER_GUILD,HOST,MANAGER,OWNER } from './helpers.js';
import { DEFAULT_APPLICATION_LIMITS } from '../src/application-limits.js';
import { handler } from '../src/interactions.js';
import { DraftFlow } from '../src/drafts.js';
import { DiscordTransport } from '../src/discord-transport.js';

const options={title:'신청 제한 검사',description:'안내',durationMinutes:60,claimMinutes:10,winners:1};
const setup=t=>fixture(t,undefined,{productionLimits:true});
function prepared(f,overrides={},host=HOST){const eid=f.engine.create(GUILD,host,{...options,...overrides});for(let slot=1;slot<=(overrides.winners||1);slot++){f.engine.setProductInfo(GUILD,host,eid,slot,`상품 ${slot}`,true);f.engine.setPrize(GUILD,host,eid,slot,content(`SECRET-${slot}`));}return eid;}
const image=bytes=>({text:'상품',images:[{ext:'png',data:Buffer.alloc(bytes,7).toString('base64')}]});
const buttons=payload=>payload.components.flatMap(row=>row.toJSON().components).map(c=>c.custom_id);
function ready(f){f.store.run("INSERT INTO panels(guild_id,channel_id,message_id,state,updated_at) VALUES (?,?,?,'READY',?)",GUILD,'panel-channel','panel',f.now());}

test('기본 초안 한도는 사용자·서버별이며 정상 UI·오래된 입력창 모두 기존 초안 이어쓰기로 안내한다',async t=>{
  const f=setup(t),eid=prepared(f),handle=handler(f.engine,f.transport);assert.deepEqual(f.engine.applicationLimits(GUILD),DEFAULT_APPLICATION_LIMITS);
  assert.throws(()=>f.engine.create(GUILD,HOST,options),error=>error.resumeEventId===eid);
  for(const i of [interaction(HOST,'ui:create'),interaction(HOST,'flow:custom:new'),interaction(HOST,'form:create',{title:'새 제목',description:'문구',duration:'60',claim:'10',winners:'1'},'modal')]){await handle(i);assert.equal(i.modal,undefined);assert.ok(buttons(i.replies[0]).includes(`ui:event:${eid}`));}
  assert.equal(f.store.get('SELECT count(*) n FROM events').n,1);assert.equal(f.store.event(eid).title,options.title);
  f.add(actor(8));f.engine.create(GUILD,actor(8),options);f.engine.create(OTHER_GUILD,HOST,options);assert.equal(f.store.get('SELECT count(*) n FROM events').n,3);
});

test('취소·거절 후에도 생성 간격과 최근 24시간 횟수가 유지되고 경계에서만 다시 열린다',t=>{
  const f=setup(t),first=prepared(f);f.engine.cancel(GUILD,HOST,first);
  assert.throws(()=>f.engine.create(GUILD,HOST,options),/간격/);f.advance(59999);assert.throws(()=>f.engine.create(GUILD,HOST,options),/간격/);f.advance(1);
  for(let n=1;n<5;n++){const eid=prepared(f);if(n%2){f.engine.submit(GUILD,HOST,eid);f.engine.rejectEvent(GUILD,MANAGER,eid,'검사');}else f.engine.cancel(GUILD,HOST,eid);f.advance(60000);}
  assert.throws(()=>f.engine.create(GUILD,HOST,options),/24시간/);assert.equal(f.store.get('SELECT count(*) n FROM events').n,5);
  f.advance(86400000-300000-1);assert.throws(()=>f.engine.create(GUILD,HOST,options),/24시간/);f.advance(1);f.engine.create(GUILD,HOST,options);assert.equal(f.store.get('SELECT count(*) n FROM events').n,6);
});

test('승인 대기 한도는 제출 직전에 검사하고 기존 신청 처리 후에는 초안을 손실 없이 제출한다',t=>{
  const f=setup(t),one=prepared(f);f.engine.submit(GUILD,HOST,one);f.advance(60000);const two=prepared(f);f.engine.submit(GUILD,HOST,two);f.advance(60000);const three=prepared(f),secret=Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=?',three).secret);
  assert.throws(()=>f.engine.submit(GUILD,HOST,three),/승인 대기 신청은 2개/);assert.equal(f.store.event(three).status,'DRAFT');assert.deepEqual(Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=?',three).secret),secret);
  f.engine.approveEvent(GUILD,MANAGER,one);f.engine.submit(GUILD,HOST,three);assert.equal(f.store.event(three).status,'PENDING');assert.equal(f.store.get('SELECT count(*) n FROM events').n,3);
});

test('미수정 초안만 기한에 만료하고 조회는 연장하지 않으며 원문 삭제·기록 유지·비공개 알림을 처리한다',async t=>{
  const f=setup(t),eid=prepared(f),flow=new DraftFlow(f.engine,f.transport);f.advance(6*86400000);f.engine.setProductInfo(GUILD,HOST,eid,1,'수정한 상품',true);const updated=f.store.get('SELECT updated_at FROM draft_activity WHERE event_id=?',eid).updated_at;
  f.advance(6*86400000);await flow.view(GUILD,HOST,eid,'review');assert.equal(f.store.get('SELECT updated_at FROM draft_activity WHERE event_id=?',eid).updated_at,updated);await f.engine.tick();assert.equal(f.store.event(eid).status,'DRAFT');
  f.advance(86400000);assert.throws(()=>f.engine.setPrize(GUILD,HOST,eid,1,content('늦은 수정')),/보관 기한이 만료/);await f.engine.tick();assert.equal(f.store.event(eid).status,'CANCELLED');assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret,null);assert.ok(f.store.get("SELECT id FROM audit WHERE event_id=? AND action='DRAFT_EXPIRED'",eid));assert.equal(f.store.get("SELECT id FROM jobs WHERE kind='closed' AND ref_id=?",eid),undefined);assert.ok(f.notifications.has(`hostDraftExpired:${eid}`));
  f.engine.create(GUILD,HOST,options);assert.equal(f.store.get('SELECT count(*) n FROM events').n,2);
});

test('기존 초안은 첫 복구부터 보관 기간을 보장하고 반복 복구·승인 대기 건은 만료 시각을 바꾸지 않는다',async t=>{
  const f=setup(t),eid=prepared(f);f.store.run('DELETE FROM draft_activity WHERE event_id=?',eid);f.advance(30*86400000);f.engine.recover();const initial=f.store.get('SELECT updated_at FROM draft_activity WHERE event_id=?',eid).updated_at;assert.ok(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret);
  f.advance(86400000);f.engine.recover();assert.equal(f.store.get('SELECT updated_at FROM draft_activity WHERE event_id=?',eid).updated_at,initial);f.engine.submit(GUILD,HOST,eid);f.advance(10*86400000);await f.engine.tick();assert.equal(f.store.event(eid).status,'PENDING');assert.ok(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret);
});

test('상품 총첨부 한도는 교체 전후 차액을 계산하고 실패 시 암호문·사용량·초안 수정 시각을 보존한다',t=>{
  const f=setup(t);f.engine.setApplicationLimits(GUILD,MANAGER,{prize_mib:1});const eid=prepared(f,{winners:2});f.engine.setPrize(GUILD,HOST,eid,1,image(600*1024));const first=Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret),second=Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=2',eid).secret),before=f.store.get('SELECT updated_at FROM draft_activity WHERE event_id=?',eid).updated_at;
  f.advance(1000);assert.throws(()=>f.engine.setPrize(GUILD,HOST,eid,2,image(600*1024)),/전체 상품 첨부/);assert.deepEqual(Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret),first);assert.deepEqual(Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=2',eid).secret),second);assert.equal(f.store.get('SELECT updated_at FROM draft_activity WHERE event_id=?',eid).updated_at,before);
  f.engine.setPrize(GUILD,HOST,eid,1,image(300*1024));f.engine.setPrize(GUILD,HOST,eid,2,image(600*1024));assert.equal(Number(f.store.get('SELECT sum(attachment_bytes) n FROM prize_uploads WHERE event_id=?',eid).n),900*1024);
  f.engine.setDeliveryMode(GUILD,HOST,eid,2,true);f.engine.setPrize(GUILD,HOST,eid,1,image(1024*1024));f.engine.submit(GUILD,HOST,eid);assert.equal(f.store.event(eid).status,'PENDING');
});

test('구 상품 첨부 사용량을 복구하고 낮아진 한도에서는 감소만 허용해 기존 내용을 보존한다',t=>{
  const f=setup(t),eid=prepared(f,{winners:2});for(let slot=1;slot<=2;slot++)f.engine.setPrize(GUILD,HOST,eid,slot,image(600*1024));f.store.run('DELETE FROM prize_uploads WHERE event_id=?',eid);f.engine.setApplicationLimits(GUILD,MANAGER,{prize_mib:1});
  assert.throws(()=>f.engine.submit(GUILD,HOST,eid),/전체 상품 첨부/);assert.ok(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret);
  f.engine.setPrize(GUILD,HOST,eid,1,image(400*1024));assert.equal(Number(f.store.get('SELECT sum(attachment_bytes) n FROM prize_uploads WHERE event_id=?',eid).n),1000*1024);f.engine.submit(GUILD,HOST,eid);assert.equal(f.store.event(eid).status,'PENDING');
});

test('신청·보관 설정 팝업은 관리자만 변경하고 부분 저장은 다른 설정을 보존한다',async t=>{
  const f=setup(t),handle=handler(f.engine,f.transport),before=f.engine.applicationLimits(GUILD);const notReady=interaction(MANAGER,'ui:applicationlimits');await handle(notReady);assert.match(notReady.replies[0].content,/gon init/);ready(f);
  for(const action of ['applicationlimits','applicationstorage']){const open=interaction(MANAGER,`ui:${action}`);await handle(open);assert.ok(open.modal);assert.ok(open.modal.toJSON().components.length<=5);}
  const denied=interaction(HOST,'form:applicationstorage',{draft_idle_days:'3',prize_mib:'25'},'modal');await handle(denied);assert.match(denied.replies[0].content,/관리자만/);
  f.add({...MANAGER,roles:[]});const revoked=interaction(MANAGER,'form:applicationlimits',{max_drafts:'2',max_pending:'3',cooldown_minutes:'2',daily_limit:'8'},'modal');await handle(revoked);assert.match(revoked.replies[0].content,/관리자만/);assert.deepEqual(f.engine.applicationLimits(GUILD),before);f.add(MANAGER);
  const storage=interaction(MANAGER,'form:applicationstorage',{draft_idle_days:'3',prize_mib:'25'},'modal');await handle(storage);const limits=interaction(MANAGER,'form:applicationlimits',{max_drafts:'2',max_pending:'3',cooldown_minutes:'2',daily_limit:'8'},'modal');await handle(limits);assert.deepEqual(f.engine.applicationLimits(GUILD),{max_drafts:2,max_pending:3,cooldown_minutes:2,daily_limit:8,draft_idle_days:3,prize_mib:25});assert.deepEqual(f.engine.applicationLimits(OTHER_GUILD),DEFAULT_APPLICATION_LIMITS);
  const saved=f.engine.applicationLimits(GUILD);for(const changes of [{max_drafts:0},{max_pending:101},{cooldown_minutes:-1},{daily_limit:0},{draft_idle_days:0},{prize_mib:1025},{daily_limit:1.5},{extra:1}])assert.throws(()=>f.engine.setApplicationLimits(GUILD,OWNER,changes));assert.deepEqual(f.engine.applicationLimits(GUILD),saved);
});

test('초안 만료 알림은 주최자 DM으로만 보내고 개인 알림 off이면 보내지 않는다',async t=>{
  const f=setup(t),eid=prepared(f),recipients=[],sent=[];const transport=new DiscordTransport({users:{async fetch(id){recipients.push(id);return{async createDM(){return{id:'host-dm'};}};}},channels:{async fetch(id){return{async send(body){sent.push({id,body});return{id:'notice',channelId:id};}};}}},f.store,f.encryption);
  await transport.sendNotification({kind:'hostDraftExpired',id:`hostDraftExpired:${eid}`},f.store.event(eid));assert.deepEqual(recipients,[HOST.userId]);assert.equal(sent[0].id,'host-dm');assert.doesNotMatch(JSON.stringify(sent),/SECRET-1/);
  f.engine.setNotices(HOST,false);await assert.rejects(transport.sendNotification({kind:'hostDraftExpired',id:`hostDraftExpired:${eid}`},f.store.event(eid)),error=>error.code==='NOTICE_DISABLED');assert.equal(sent.length,1);
});
