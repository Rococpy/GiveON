import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function run(scenario) {
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/shutdown-child.js',import.meta.url)),scenario],{timeout:5000,windowsHide:true,encoding:'utf8'});
  if(child.error)throw child.error;
  return {code:child.status,signal:child.signal,out:child.stdout.replaceAll('\r\n','\n'),err:child.stderr};
}

test('DB 잠금 반납이 실패해도 실제 워커를 닫고 비정상 종료한다',async()=>{
  const result=await run('db-error');
  assert.equal(result.code,1);assert.equal(result.signal,null);
  assert.equal(result.err,'');assert.match(result.out,/discord closed\nstore closed/);
});

test('정상 종료는 잠금과 자원을 반납하고 성공 코드로 끝난다',async()=>{
  const result=await run('normal');
  assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(result.err,'');
  assert.match(result.out,/lease released\nstore closed/);
});

test('Discord 종료 오류도 DB 정리를 건너뛰지 않는다',async()=>{
  const result=await run('discord-error');
  assert.equal(result.code,1);assert.equal(result.err,'');assert.match(result.out,/store closed/);
});

test('소켓 정리가 멈춰도 제한시간 후 종료해 PM2가 재시작할 수 있다',async()=>{
  const result=await run('hung-handles');
  assert.equal(result.code,1);assert.equal(result.signal,null);assert.equal(result.err,'');
  assert.match(result.out,/close attempted/);
});
