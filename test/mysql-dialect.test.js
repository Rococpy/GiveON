import test from 'node:test';
import assert from 'node:assert/strict';
import { mysqlSql,mysqlTable,mysqlSchema } from '../src/mysql-schema.js';
import { config } from '../src/config.js';

test('MySQL 접두어는 DDL·외래키·중복 처리의 테이블만 바꾸고 문자열과 주석을 보존한다',()=>{
  const options={prefix:'giveon_'};
  assert.match(mysqlSql(mysqlSchema[2],options),/CREATE TABLE IF NOT EXISTS giveon_events/);
  assert.match(mysqlSql(mysqlSchema[2],options),/REFERENCES giveon_guilds\(id\)/);
  assert.equal(mysqlSql("UPDATE `events` SET description='events \\' guilds',title='prizes' WHERE id=? /* events */ -- claims",options),"UPDATE `giveon_events` SET description='events \\' guilds',title='prizes' WHERE id=? /* events */ -- claims");
  assert.equal(mysqlSql('INSERT OR IGNORE INTO entries(event_id,user_id) VALUES (?,?)',options),'INSERT INTO giveon_entries(event_id,user_id) VALUES (?,?) ON DUPLICATE KEY UPDATE event_id=giveon_entries.event_id');
});
test('MariaDB upsert는 VALUES를 사용하고 기존 MySQL은 incoming 별칭을 유지한다',()=>{
  const sql='INSERT INTO notification_prefs(user_id,enabled,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at';
  assert.equal(mysqlSql(sql,{prefix:'gon_',mariaDB:true}),'INSERT INTO gon_notification_prefs(user_id,enabled,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),updated_at=VALUES(updated_at)');
  assert.match(mysqlSql(sql),/AS incoming ON DUPLICATE KEY UPDATE enabled=incoming.enabled/);
});
test('프로젝트 접두어는 짧은 영문 소문자 식별자만 허용한다',()=>{
  const env={DISCORD_TOKEN:'test',APPLICATION_ID:'100000000000001',OWNER_IDS:'100000000000002',DATA_KEY:'ab'.repeat(32),DB_DRIVER:'mysql',MYSQL_HOST:'host',MYSQL_USER:'user',MYSQL_DATABASE:'db'};
  assert.equal(config({...env,MYSQL_TABLE_PREFIX:'giveon_'}).mysql.tablePrefix,'giveon_');
  assert.equal(config(env).mysql.tablePrefix,'');
  for(const prefix of ['a;DROP TABLE events','../','9bad','A_', 'a'.repeat(25)])assert.throws(()=>config({...env,MYSQL_TABLE_PREFIX:prefix}),/접두어/);
  assert.equal(mysqlTable('events','giveon_'),'giveon_events');
});
