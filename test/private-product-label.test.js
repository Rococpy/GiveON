import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,actor,content,interaction,GUILD,HOST,MANAGER,OWNER } from './helpers.js';
import { handler } from '../src/interactions.js';
import { DiscordTransport } from '../src/discord-transport.js';
import { eventView,productsView } from '../src/ui.js';

async function published(f,winners=2) {
  const eid=f.engine.create(GUILD,HOST,{title:'상품 표시 검사',description:'안내',durationMinutes:1,claimMinutes:1,winners});
  for(let slot=1;slot<=winners;slot++){
    f.engine.setProductInfo(GUILD,HOST,eid,slot,`PRIVATE-${slot}`,false,slot===1);
    f.engine.setPrize(GUILD,HOST,eid,slot,content(`SECRET-CODE-${slot}`));
  }
  f.engine.submit(GUILD,HOST,eid);await f.engine.tick();f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();return eid;
}
function setup(t){const f=fixture(t),transport=new DiscordTransport({},f.store,f.encryption);f.transport.eventEmbed=transport.eventEmbed.bind(transport);return {...f,handle:handler(f.engine,f.transport),discord:transport};}

test('상세보기는 주최자·관리자에게 비공개(상품명)을 표시하고 일반 참여자에게는 실제 이름을 숨긴다',async t=>{
  const f=setup(t),eid=await published(f),publicUser=actor(99);f.add(publicUser);
  for(const viewer of [HOST,MANAGER,OWNER]){
    const i=interaction(viewer,`ui:event:${eid}`);await f.handle(i);
    const text=JSON.stringify(i.replies);assert.match(text,/비공개\(PRIVATE-1\)/);assert.match(text,/비공개\(PRIVATE-2\)/);assert.doesNotMatch(text,/SECRET-CODE/);
    const products=interaction(viewer,`ui:products:${eid}:0`);await f.handle(products);assert.match(products.replies[0].content,/비공개\(PRIVATE-2\)/);
  }
  const normal=interaction(publicUser,`ui:event:${eid}`);await f.handle(normal);assert.match(JSON.stringify(normal.replies),/비공개 상품/);assert.doesNotMatch(JSON.stringify(normal.replies),/PRIVATE-|SECRET-CODE/);
  assert.doesNotMatch(productsView(f.engine,GUILD,publicUser,eid).content,/PRIVATE-/);
  assert.doesNotMatch(JSON.stringify(f.discord.publicEvent(f.store.event(eid))),/PRIVATE-/);
});

test('상품 페이지 이동·관리 화면에서도 비공개 표시를 유지하고 관리 역할 해제 후에는 이름을 숨긴다',async t=>{
  const f=setup(t),eid=await published(f,11);
  const page=interaction(MANAGER,`ui:manageproducts:${eid}:1`);await f.handle(page);assert.match(page.replies[0].content,/비공개\(PRIVATE-11\)/);
  assert.match(JSON.stringify(eventView(f.engine,f.discord,GUILD,MANAGER,eid,0,true)),/비공개\(PRIVATE-1\)/);
  assert.match(productsView(f.engine,GUILD,HOST,eid,1).content,/비공개\(PRIVATE-11\)/);
  f.add({...MANAGER,roles:[]});
  const normal=interaction(MANAGER,`ui:products:${eid}:1`);await f.handle(normal);assert.doesNotMatch(JSON.stringify(normal.replies),/PRIVATE-/);
  const denied=interaction(MANAGER,`ui:manageproducts:${eid}:1`);await f.handle(denied);assert.match(denied.replies[0].content,/관리자만/);assert.doesNotMatch(JSON.stringify(denied.replies),/PRIVATE-/);
});

test('수령 후 공개된 상품은 비공개 표시를 제거하고 계속 비공개 상품은 유지한다',async t=>{
  const f=setup(t),eid=await published(f),users=[actor(4),actor(5)];f.add(...users);for(const user of users)f.engine.join(GUILD,user,eid);
  f.advance(60001);await f.engine.tick();const claim=f.claims(eid).find(c=>c.slot===1);
  await f.engine.startClaim(GUILD,f.members.get(claim.user_id),claim.id);
  for(const viewer of [HOST,MANAGER,OWNER,actor(99)]){
    const view=eventView(f.engine,f.discord,GUILD,viewer,eid),text=JSON.stringify(view);
    assert.match(text,/PRIVATE-1/);assert.doesNotMatch(text,/비공개\(PRIVATE-1\)/);
    if(viewer===HOST||viewer===MANAGER||viewer===OWNER)assert.match(text,/비공개\(PRIVATE-2\)/);else assert.doesNotMatch(text,/PRIVATE-2/);
  }
  const raw=f.store.get('SELECT name FROM prizes WHERE event_id=? AND slot=2',eid).name;
  assert.equal(f.encryption.open(raw,`product-name:${eid}:2`).text,'PRIVATE-2');
});
