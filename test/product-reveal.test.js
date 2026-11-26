import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,actor,content,interaction,GUILD,HOST,MANAGER } from './helpers.js';
import { handler } from '../src/interactions.js';
import { DiscordTransport } from '../src/discord-transport.js';
import { productModal,productsView } from '../src/ui.js';
const options={title:'수령 후 상품명 공개',description:'안내',durationMinutes:1,claimMinutes:1,winners:1};
function draft(f,winners=1,proof=false){const eid=f.engine.create(GUILD,HOST,{...options,winners,proofRequired:proof,proofInstructions:proof?'인증 제출':''});for(let slot=1;slot<=winners;slot++){f.engine.setProductInfo(GUILD,HOST,eid,slot,`PRIVATE-NAME-${slot}`,false,true);f.engine.setPrize(GUILD,HOST,eid,slot,content(`SECRET-CODE-${slot}`));}return eid;}
async function draw(f,eid,users){f.engine.submit(GUILD,HOST,eid);await f.engine.tick();f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();f.add(...users);for(const u of users)f.engine.join(GUILD,u,eid);f.advance(60001);await f.engine.tick();return f.claims(eid).sort((a,b)=>a.slot-b.slot);}
const current=(f,eid)=>f.store.event(eid);

test('공개 선택은 세 가지이며 명시적 선택만 암호화 저장하고 전달 내용·권한을 보존한다',async t=>{
  const f=fixture(t),eid=await f.event({start:false}),handle=handler(f.engine,f.transport),before=Buffer.from(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret);
  const i=interaction(HOST,`form:product:${eid}:1`,{name:'PRIVATE-AFTER',visibility:'after_delivery'},'modal');await handle(i);const p=f.engine.product(current(f,eid),1,true);
  assert.equal(p.revealAfterDelivery,true);assert.equal(p.publicName,false);assert.equal(f.engine.product(current(f,eid),1).name,'비공개 상품');
  const row=f.store.get('SELECT name,secret,name_public FROM prizes WHERE event_id=?',eid);assert.equal(row.name_public,0);assert.equal(Buffer.from(row.name).includes(Buffer.from('PRIVATE-AFTER')),false);assert.equal(f.encryption.open(row.name,`product-name:${eid}:1`).revealAfterDelivery,true);assert.deepEqual(Buffer.from(row.secret),before);
  const modal=productModal(current(f,eid),p).toJSON(),choices=modal.components[1].component.options;assert.deepEqual(choices.map(c=>c.value),['public','private','after_delivery']);assert.deepEqual(choices.filter(c=>c.default).map(c=>c.value),['after_delivery']);assert.match(JSON.stringify(modal),/실물.*연락 안내/);
  assert.throws(()=>f.engine.setProductInfo(GUILD,HOST,eid,1,'name',true,true),/공개 여부/);assert.throws(()=>f.engine.setProductInfo(GUILD,HOST,eid,1,'name',false,'yes'),/공개 여부/);assert.throws(()=>f.engine.setProductInfo(GUILD,MANAGER,eid,1,'name',false,true),/본인의/);
  f.engine.setProductInfo(GUILD,HOST,eid,1,'PRIVATE-STAYS',false);assert.equal(f.engine.product(current(f,eid),1,true).revealAfterDelivery,false);
});

test('다른 당첨자가 수령 중이어도 완료된 상품만 공개하고 원본 카드·목록을 갱신한다',async t=>{
  const f=fixture(t),eid=draft(f,2),claims=await draw(f,eid,[actor(4),actor(5)]),transport=new DiscordTransport({},f.store,f.encryption);
  assert.doesNotMatch(JSON.stringify(transport.publicEvent(current(f,eid))),/PRIVATE-NAME/);assert.match(productsView(f.engine,GUILD,MANAGER,eid).content,/비공개\(PRIVATE-NAME-1\)/);
  await f.engine.startClaim(GUILD,f.members.get(claims[0].user_id),claims[0].id);assert.equal(current(f,eid).status,'DRAWN');assert.equal(f.engine.product(current(f,eid),1).name,'PRIVATE-NAME-1');assert.equal(f.engine.product(current(f,eid),2).name,'비공개 상품');assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret,null);assert.equal(f.engine.dirty.has(eid),true);
  const edits=[];f.transport.updateEvent=async e=>edits.push(transport.publicEvent(e));await f.engine.tick();assert.match(JSON.stringify(edits),/PRIVATE-NAME-1/);assert.doesNotMatch(JSON.stringify(edits),/PRIVATE-NAME-2|SECRET-CODE/);
  const visible=productsView(f.engine,GUILD,actor(99),eid);assert.match(visible.content,/PRIVATE-NAME-1/);assert.doesNotMatch(visible.content,/PRIVATE-NAME-2/);
});

test('인증 대기와 전송 결과 불명 상태에는 숨기고 DM 지급을 확인한 뒤에만 공개한다',async t=>{
  const f=fixture(t),eid=draft(f,1,true),[c]=await draw(f,eid,[actor(4)]),user=f.members.get(c.user_id);await f.engine.startClaim(GUILD,user,c.id);assert.equal(f.engine.product(current(f,eid),1).publicName,false);
  f.engine.submitProof(GUILD,user,c.id,content('PROOF'));assert.equal(f.engine.product(current(f,eid),1).publicName,false);f.transport.behavior='unknown';await f.engine.review(GUILD,HOST,c.id,1,'approve');assert.equal(f.store.claim(c.id).status,'DELIVERY_UNKNOWN');assert.equal(f.engine.product(current(f,eid),1).name,'비공개 상품');
  await f.engine.reconcile(GUILD,MANAGER,c.id);assert.equal(f.store.claim(c.id).status,'DELIVERED');assert.equal(f.store.claim(c.id).proof,null);assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret,null);assert.equal(f.engine.product(current(f,eid),1).name,'PRIVATE-NAME-1');
});

test('설정이 없는 구 암호문과 계속 비공개는 지급이 끝나도 자동 공개하지 않는다',async t=>{
  const f=fixture(t),eid=draft(f,2);f.store.run('UPDATE prizes SET name=? WHERE event_id=? AND slot=1',f.encryption.seal({text:'LEGACY-PRIVATE'},`product-name:${eid}:1`),eid);f.engine.setProductInfo(GUILD,HOST,eid,2,'STAYS-PRIVATE',false);
  const claims=await draw(f,eid,[actor(4),actor(5)]);for(const c of claims)await f.engine.startClaim(GUILD,f.members.get(c.user_id),c.id);assert.equal(current(f,eid).status,'COMPLETED');for(const slot of [1,2])assert.equal(f.engine.product(current(f,eid),slot).name,'비공개 상품');
});

test('취소되거나 참가자가 없어 종료된 상품은 수령 후 공개를 선택해도 비공개를 유지한다',async t=>{
  const f=fixture(t),cancelled=draft(f);f.engine.cancel(GUILD,HOST,cancelled);assert.equal(f.engine.product(current(f,cancelled),1).publicName,false);
  const ended=draft(f);await draw(f,ended,[]);assert.equal(current(f,ended).status,'COMPLETED');assert.equal(f.store.get('SELECT status FROM prizes WHERE event_id=?',ended).status,'EXHAUSTED');assert.equal(f.engine.product(current(f,ended),1).name,'비공개 상품');
});

test('실물은 실제 배송 대신 연락 안내 DM이 완료된 시점을 공개 기준으로 사용한다',async t=>{
  const f=fixture(t),eid=draft(f);f.engine.setDeliveryMode(GUILD,HOST,eid,1,true);const [c]=await draw(f,eid,[actor(4)]);assert.equal(f.engine.product(current(f,eid),1).publicName,false);await f.engine.startClaim(GUILD,f.members.get(c.user_id),c.id);assert.equal(f.engine.product(current(f,eid),1).name,'PRIVATE-NAME-1');assert.equal(f.engine.product(current(f,eid),1).direct,true);assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=?',eid).secret,null);
});
