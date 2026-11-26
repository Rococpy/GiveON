import test from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle } from 'discord.js';
import { fixture,actor,content,GUILD,HOST,MANAGER } from './helpers.js';
import { DiscordTransport } from '../src/discord-transport.js';

async function event(f,{proof=false,mixed=false}={}) {
  const eid=f.engine.create(GUILD,HOST,{title:'실물 연결 이벤트',description:'안내',durationMinutes:1,claimMinutes:1,winners:mixed?2:1,proofRequired:proof,proofInstructions:proof?'인증 제출':''});
  f.engine.setProductInfo(GUILD,HOST,eid,1,'PRIVATE-KEYBOARD',false);
  f.engine.setDeliveryMode(GUILD,HOST,eid,1,true);
  if(mixed){f.engine.setProductInfo(GUILD,HOST,eid,2,'디지털 상품',true);f.engine.setPrize(GUILD,HOST,eid,2,content('DIGITAL-SECRET'));}
  f.engine.submit(GUILD,HOST,eid);await f.engine.tick();f.engine.approveEvent(GUILD,MANAGER,eid);await f.engine.tick();
  const users=mixed?[actor(4),actor(5)]:[actor(4)];f.add(...users);for(const user of users)f.engine.join(GUILD,user,eid);
  f.advance(60001);await f.engine.tick();
  return {eid,claims:f.claims(eid).sort((a,b)=>a.slot-b.slot)};
}
function connect(f) {
  const sent=[],client={
    users:{async fetch(id){return {async createDM(){return {id:`dm-${id}`};}};}},
    channels:{async fetch(id){return {async send(body){const message={id:`sent-${sent.length+1}`,channelId:id};sent.push({channelId:id,body,message});return message;}};}},
  };
  const transport=new DiscordTransport(client,f.store,f.encryption);
  for(const key of ['prepareDM','sendPrize','sendNotification'])f.transport[key]=transport[key].bind(transport);
  return {client,sent,transport};
}
const buttons=body=>body.components.flatMap(c=>c.toJSON().components);
const delivered=sent=>sent.filter(s=>s.body.embeds?.[0].toJSON().footer?.text.startsWith('giveaway-delivery:'));

test('실물 당사자 양쪽 DM에 상품명과 상대 프로필을 넣고 디지털·공개 알림에는 연락 버튼을 넣지 않는다',async t=>{
  const f=fixture(t),{eid,claims}=await event(f,{mixed:true}),{sent}=connect(f);
  for(const c of claims)await f.engine.startClaim(GUILD,f.members.get(c.user_id),c.id);
  await f.engine.processJobs();const physical=claims[0];
  const winner=delivered(sent).find(s=>s.channelId===`dm-${physical.user_id}`);
  const host=sent.find(s=>s.body.embeds[0].toJSON().footer.text===`job:hostReceived:${physical.id}`);
  for(const item of [winner,host]){
    assert.match(JSON.stringify(item.body),/실물 연결 이벤트.*1번/s);assert.match(JSON.stringify(item.body),/PRIVATE-KEYBOARD/);
    assert.match(JSON.stringify(item.body),/주소.*봇에 제출하지/);assert.match(JSON.stringify(item.body),/배송·실물 수령 완료를 뜻하지/);
    assert.deepEqual(item.body.allowedMentions.parse,[]);
  }
  assert.equal(host.channelId,`dm-${HOST.userId}`);
  assert.deepEqual(buttons(winner.body).map(b=>({style:b.style,url:b.url})),[{style:ButtonStyle.Link,url:`https://discord.com/users/${HOST.userId}`}]);
  assert.deepEqual(buttons(host.body).map(b=>({style:b.style,url:b.url})),[{style:ButtonStyle.Link,url:`https://discord.com/users/${physical.user_id}`}]);
  const digital=delivered(sent).find(s=>s!==winner);assert.deepEqual(digital.body.components,[]);assert.match(JSON.stringify(digital.body),/DIGITAL-SECRET/);
  for(const item of sent.filter(s=>!s.channelId.startsWith('dm-'))){assert.deepEqual(item.body.components,[]);assert.doesNotMatch(JSON.stringify(item.body),/PRIVATE-KEYBOARD|discord.com\/users|DIGITAL-SECRET/);}
  assert.equal(f.store.get('SELECT secret FROM prizes WHERE event_id=? AND slot=1',eid).secret,null);
  await f.engine.processJobs();assert.equal(delivered(sent).length,2);assert.equal(sent.filter(s=>s.body.embeds[0].toJSON().footer.text===`job:hostReceived:${physical.id}`).length,1);
});

test('인증 승인 전에는 연락하지 않고 승인 후 양쪽 DM을 연결하며 인증 원문을 지운다',async t=>{
  const f=fixture(t),{claims:[c]}=await event(f,{proof:true}),{sent}=connect(f),user=f.members.get(c.user_id);
  await f.engine.startClaim(GUILD,user,c.id);assert.equal(sent.length,0);
  f.engine.submitProof(GUILD,user,c.id,content('PRIVATE-PROOF'));await f.engine.processJobs();
  assert.equal(delivered(sent).length,0);assert.equal(f.store.get('SELECT id FROM jobs WHERE id=?',`hostReceived:${c.id}`),undefined);
  await f.engine.review(GUILD,HOST,c.id,1,'approve');await f.engine.processJobs();
  assert.equal(delivered(sent).length,1);assert.ok(sent.some(s=>s.channelId===`dm-${HOST.userId}`&&buttons(s.body).some(b=>b.url===`https://discord.com/users/${c.user_id}`)));
  assert.equal(f.store.claim(c.id).proof,null);assert.doesNotMatch(JSON.stringify(sent),/PRIVATE-PROOF/);
});

test('주최자 알림 끄기를 존중하며 당첨자에게는 실물 연락 안내를 전달한다',async t=>{
  const f=fixture(t),{claims:[c]}=await event(f),{sent}=connect(f);f.engine.setNotices(HOST,false);
  await f.engine.startClaim(GUILD,f.members.get(c.user_id),c.id);await f.engine.processJobs();
  assert.equal(delivered(sent).length,1);assert.ok(buttons(delivered(sent)[0].body).some(b=>b.url===`https://discord.com/users/${HOST.userId}`));
  assert.equal(sent.some(s=>s.channelId===`dm-${HOST.userId}`),false);
  assert.equal(f.store.get('SELECT error_code FROM jobs WHERE id=?',`hostReceived:${c.id}`).error_code,'NOTICE_DISABLED');
});

test('주최자 DM 차단 시 공개로 연락정보를 보내지 않고 주최자 DM만 재시도한다',async t=>{
  const f=fixture(t),{claims:[c]}=await event(f),{client,sent}=connect(f),fetchUser=client.users.fetch;
  client.users.fetch=async id=>{if(id===HOST.userId)throw Object.assign(new Error('DM blocked'),{code:50007});return fetchUser(id);};
  await f.engine.startClaim(GUILD,f.members.get(c.user_id),c.id);await f.engine.processJobs();
  const job=f.store.get('SELECT * FROM jobs WHERE id=?',`hostReceived:${c.id}`);assert.equal(job.status,'PENDING');assert.equal(job.channel_id,null);
  assert.equal(delivered(sent).length,1);
  for(const item of sent.filter(s=>!s.channelId.startsWith('dm-')))assert.doesNotMatch(JSON.stringify(item.body),/discord.com\/users|PRIVATE-KEYBOARD/);
  client.users.fetch=fetchUser;f.advance(60001);await f.engine.processJobs();
  assert.equal(delivered(sent).length,1);assert.equal(sent.filter(s=>s.channelId===`dm-${HOST.userId}`).length,1);
  assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?',`hostReceived:${c.id}`).status,'DONE');
});
