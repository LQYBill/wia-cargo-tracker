import test from 'node:test';import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{openStore}from'../lib/store.mjs';import{accounts,passwordHash}from'../lib/accounts.mjs';
test('1.0升级保留运单及面单、撤销旧会话，初始化ADMIN只执行一次',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cargo-migrate-'));let db=new DatabaseSync(join(dir,'cargo.sqlite'));
 db.exec(`CREATE TABLE shipments(id TEXT PRIMARY KEY,product TEXT NOT NULL,number TEXT NOT NULL UNIQUE,carrier TEXT NOT NULL,batch TEXT NOT NULL DEFAULT '',destination TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',attachment TEXT,created TEXT NOT NULL,last_sync TEXT,error TEXT,next_sync INTEGER NOT NULL DEFAULT 0,registered INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,carrier_code INTEGER);
 CREATE TABLE sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);CREATE TABLE attachments(id TEXT PRIMARY KEY,mime TEXT NOT NULL,created TEXT NOT NULL);
 INSERT INTO shipments(id,product,number,carrier,attachment,created) VALUES('legacy','旧运单','1Z14V4W16800446871','UPS','label','2026-11-09T00:00:00Z');
 INSERT INTO attachments VALUES('label','image/png','2026-11-09T00:00:00Z');INSERT INTO sessions VALUES('old-token',9999999999999);`);db.close();
 const s=openStore(dir);try{
  assert.equal(s.get('legacy').product,'旧运单');assert.equal(s.get('legacy').sales_id,null);assert.equal(s.db.prepare('SELECT count(*) n FROM sessions').get().n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM attachments').get().n,1);
  const a=accounts(s);const h=passwordHash('migration-test-password');a.bootstrap(h);assert.equal(a.list().length,1);assert.equal(a.list()[0].username,'admin');a.bootstrap(passwordHash('another-password'));assert.equal(s.db.prepare('SELECT password_hash FROM users').get().password_hash,h);
 }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});
