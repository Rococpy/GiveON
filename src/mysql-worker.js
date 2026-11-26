import { workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { mysqlSchema,mysqlSql,mysqlTable } from './mysql-schema.js';

const {port,signal,options}=workerData,flag=new Int32Array(signal);
let connection,mariaDB=false;
const prefix=options.tablePrefix||'';
const query=(sql,args)=>connection.query(mysqlSql(sql,{prefix,mariaDB}),args);
const fatalCodes=new Set(['PROTOCOL_CONNECTION_LOST','PROTOCOL_SEQUENCE_TIMEOUT','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EPIPE']);
const params=values=>values.map(value=>value instanceof Uint8Array?Buffer.from(value):value);
async function initialize() {
  const {tablePrefix,...connectionOptions}=options;mysqlTable('events',prefix);
  connection=await mysql.createConnection({...connectionOptions,charset:'utf8mb4',supportBigNumbers:true,bigNumberStrings:false,
    flags:'-FOUND_ROWS',multipleStatements:false,enableKeepAlive:true,connectTimeout:options.connectTimeout});
  const [[server]]=await connection.query('SELECT VERSION() version,@@max_allowed_packet packet');
  const version=server.version.match(/^(\d+)\.(\d+)\.(\d+)/);
  mariaDB=/mariadb/i.test(server.version);
  if(!version||(mariaDB?(Number(version[1])<10||(Number(version[1])===10&&Number(version[2])<11)):(Number(version[1])<8||(Number(version[1])===8&&Number(version[2])===0&&Number(version[3])<19))))throw Object.assign(new Error('VERSION'),{code:'MYSQL_VERSION_UNSUPPORTED'});
  if(server.packet<16*1024*1024)throw Object.assign(new Error('PACKET'),{code:'MYSQL_PACKET_TOO_SMALL'});
  // 연결에 귀속된 잠금으로 같은 DB를 사용하는 복수 프로세스의 기동을 막습니다.
  const lock='giveon:'+createHash('sha256').update(prefix?options.database+'\0'+prefix:options.database).digest('hex').slice(0,48);
  const [[row]]=await connection.execute('SELECT GET_LOCK(?,0) acquired',[lock]);
  if(row.acquired!==1)throw Object.assign(new Error('LOCKED'),{code:'MYSQL_DATABASE_IN_USE'});
  await query(mysqlSchema[0]);
  const [[metadata]]=await query('SELECT version FROM giveon_metadata WHERE id=1');
  if(metadata&&metadata.version>1)throw Object.assign(new Error('SCHEMA'),{code:'MYSQL_SCHEMA_NEWER'});
  for(const sql of mysqlSchema.slice(1))await query(sql);
  const [eventIndexes]=await connection.execute('SELECT DISTINCT INDEX_NAME name FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[mysqlTable('events',prefix)]);
  for(const [name,columns] of Object.entries({owner_created:'guild_id,owner_id,created_at',owner_state:'guild_id,owner_id,status'})) {
    if(!eventIndexes.some(index=>index.name===name))await query(`CREATE INDEX ${name} ON events(${columns})`);
  }
  const [prizeColumns]=await connection.execute('SELECT COLUMN_NAME name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[mysqlTable('prizes',prefix)]);
  if(!prizeColumns.some(column=>column.name==='delivery_mode'))await query("ALTER TABLE prizes ADD COLUMN delivery_mode VARCHAR(16) NOT NULL DEFAULT 'DIGITAL'");
  if(!prizeColumns.some(column=>column.name==='name'))await query('ALTER TABLE prizes ADD COLUMN name BLOB');
  if(!prizeColumns.some(column=>column.name==='name_public'))await query('ALTER TABLE prizes ADD COLUMN name_public TINYINT NOT NULL DEFAULT 1');
  await connection.beginTransaction();
  try {
    await query("UPDATE prizes SET delivery_mode='DIRECT' WHERE event_id IN (SELECT event_id FROM direct_events)");
    await query('DELETE FROM direct_events');
    await connection.commit();
  }catch(error){await connection.rollback();throw error;}
  const [blockColumns]=await connection.execute('SELECT COLUMN_NAME name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[mysqlTable('host_blocks',prefix)]);
  const existing=new Set(blockColumns.map(column=>column.name));
  for(const [name,definition] of Object.entries({reason:"VARCHAR(500) NOT NULL DEFAULT ''",active:'TINYINT NOT NULL DEFAULT 1',released_by:'VARCHAR(22) CHARACTER SET ascii COLLATE ascii_bin',released_at:'BIGINT'})) {
    if(!existing.has(name))await query(`ALTER TABLE host_blocks ADD COLUMN ${name} ${definition}`);
  }
  await query('INSERT INTO giveon_metadata(id,version) VALUES(1,1) ON DUPLICATE KEY UPDATE id=id');
  return {version:server.version,flavor:mariaDB?'mariadb':'mysql',maxAllowedPacket:server.packet,tablePrefix:prefix};
}
port.on('message',async request=>{
  let response;
  try {
    let value;
    if(request.operation==='initialize')value=await initialize();
    else if(request.operation==='close'){await connection?.end();value=true;}
    else if(request.operation==='begin'){await connection.beginTransaction();value=true;}
    else if(request.operation==='commit'){await connection.commit();value=true;}
    else if(request.operation==='rollback'){await connection.rollback();value=true;}
    else {
      const [result]=await connection.execute({sql:mysqlSql(request.sql,{prefix,mariaDB}),timeout:options.connectTimeout},params(request.args));
      value=request.operation==='get'?result[0]:request.operation==='all'?result:{changes:result.affectedRows,lastInsertRowid:result.insertId};
    }
    response={id:request.id,ok:true,value};
  } catch(error) {
    response={id:request.id,ok:false,code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'MYSQL_ERROR',fatal:Boolean(error.fatal)||fatalCodes.has(error.code)};
    if(request.operation==='initialize')await connection?.end().catch(()=>{});
  }
  port.postMessage(response);Atomics.store(flag,0,1);Atomics.notify(flag,0);
  if(request.operation==='close')port.close();
});
