import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {metrics,validTime,labels,normalizeNumber} from './model.mjs';
import {shippingFields} from './shipping.mjs';
export function openStore(dir) {
 mkdirSync(dir,{recursive:true,mode:0o700});
 const db=new DatabaseSync(join(dir,'cargo.sqlite')); db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 db.exec(`CREATE TABLE IF NOT EXISTS shipments(id TEXT PRIMARY KEY,product TEXT NOT NULL,number TEXT NOT NULL UNIQUE,carrier TEXT NOT NULL,batch TEXT NOT NULL DEFAULT '',destination TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',attachment TEXT,created TEXT NOT NULL,last_sync TEXT,error TEXT,next_sync INTEGER NOT NULL DEFAULT 0,registered INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,carrier_code INTEGER);
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,shipment TEXT NOT NULL REFERENCES shipments(id),time TEXT NOT NULL,kind TEXT NOT NULL,description TEXT NOT NULL,location TEXT NOT NULL,source TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,shipment TEXT NOT NULL REFERENCES shipments(id),title TEXT NOT NULL,created TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,shipment TEXT NOT NULL REFERENCES shipments(id),payload TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,mime TEXT NOT NULL,created TEXT NOT NULL);`);
 // Additive migration keeps existing shipments, events and attachments intact.
 const column=(table,name,type)=>{if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);};
 db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('ADMIN','LOGISTICS','SALES','SUPPORT')),password_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL,created_by TEXT);
 CREATE TABLE IF NOT EXISTS notification_reads(notification TEXT NOT NULL REFERENCES notifications(id),user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(notification,user_id));
 CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY,actor TEXT,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);`);
 column('shipments','inbound_customer','TEXT');
 column('shipments','sales_id_2','TEXT REFERENCES users(id)');
 column('shipments','sales_id','TEXT REFERENCES users(id)');column('shipments','created_by','TEXT REFERENCES users(id)');
 const oldSessions=!db.prepare('PRAGMA table_info(sessions)').all().some(c=>c.name==='user_id');
 column('sessions','user_id','TEXT REFERENCES users(id)');column('attachments','uploaded_by','TEXT REFERENCES users(id)');
 if(oldSessions)db.exec('DELETE FROM sessions');
 db.exec('CREATE INDEX IF NOT EXISTS shipments_sales ON shipments(sales_id); CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);');
 for(const name of ['transport_mode','freight_company','confirmed_weight','unit_price','total_price','currency'])column('shipments',name,'TEXT');
 db.prepare('UPDATE shipments SET transport_mode=? WHERE transport_mode=?').run('铁路','地铁');
 column('shipments','transfer_number','TEXT');
 db.exec('CREATE TABLE IF NOT EXISTS t6_checks(shipment TEXT PRIMARY KEY REFERENCES shipments(id), company TEXT NOT NULL, number TEXT NOT NULL, day TEXT NOT NULL, checked_at TEXT NOT NULL, events TEXT, error TEXT)');
 column('shipments','deleted_at','TEXT');column('shipments','deleted_by','TEXT REFERENCES users(id)');
 column('shipments','other_fees','TEXT');column('shipments','other_fees_note','TEXT');
 column('shipments','payment_status',"TEXT NOT NULL DEFAULT 'unpaid'");column('shipments','paid_at','TEXT');column('shipments','paid_by','TEXT REFERENCES users(id)');
 column('shipments','last_attempt','TEXT');column('shipments','query_warning','TEXT');column('shipments','package_total','INTEGER');
 db.exec(`CREATE TABLE IF NOT EXISTS package_tracks(shipment TEXT NOT NULL REFERENCES shipments(id),number TEXT NOT NULL,status TEXT NOT NULL,description TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(shipment,number));`);
 db.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,shipment TEXT NOT NULL REFERENCES shipments(id),kind TEXT NOT NULL CHECK(kind IN ('invoice','products')),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created TEXT NOT NULL,uploaded_by TEXT NOT NULL REFERENCES users(id));CREATE INDEX IF NOT EXISTS documents_shipment ON documents(shipment);`);
 column('documents','file_id','TEXT');
 db.exec(`CREATE TABLE IF NOT EXISTS tracking_archives(id TEXT PRIMARY KEY,shipment TEXT NOT NULL REFERENCES shipments(id),number TEXT NOT NULL,carrier TEXT NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL,actor TEXT NOT NULL REFERENCES users(id));
 CREATE TABLE IF NOT EXISTS document_versions(id TEXT PRIMARY KEY,document TEXT NOT NULL REFERENCES documents(id),file_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created TEXT NOT NULL,actor TEXT NOT NULL REFERENCES users(id));`);
 const events=id=>db.prepare('SELECT * FROM events WHERE shipment=? ORDER BY time').all(id).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
 const get=id=>{
  const s=db.prepare('SELECT * FROM shipments WHERE id=?').get(id);if(!s)return null;
  const packages=db.prepare('SELECT number,status,description,checked_at FROM package_tracks WHERE shipment=?').all(id);
  const total=s.package_total||packages.length,allDelivered=total>0&&packages.length===total&&packages.every(p=>p.status==='delivered');
  const t6=db.prepare('SELECT events,error,checked_at FROM t6_checks WHERE shipment=? AND company=? AND number=?').get(id,s.freight_company||'',s.transfer_number||s.number);
  const t6_tracking=t6?{...t6,events:JSON.parse(t6.events||'[]')}:null;
  const timeline=[...events(id),...(t6_tracking?.events||[]).map((event,index)=>({
   id:'t6-'+index,time:event.time.replace(' ','T')+'+08:00',original_time:event.time,
   description:event.description,location:'',source:'运输更新',
   kind:/^货件信息已发送给\s*FedEx\b|shipper created a label|label created/i.test(event.description)?'label':
    /^【[^】]+】\s*已收取\s*$/.test(event.description)?'pickup':
    /^【[^】]+】\s*已装上\s*FedEx\s*车辆等待递送\s*$/i.test(event.description)?'out':'unknown'
  }))].filter(e=>validTime(e.time)).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  // A confirmed departure starts online tracking for bulk shipments.
  let onlineDeparture=null;
  if(s.number&&!timeline.some(event=>event.kind==='label')){
   const departure=timeline.find(event=>event.original_time
    && event.description.split(/[，,。；;]/).some(part=>
     !/预计|计划|准备|尚未|未发车|未开船/.test(part)
     && /已发车|已发运|已启运|已开船|已离港|已经开船/.test(part)));
   if(departure)onlineDeparture={...departure,kind:'label'};
  }
  const m=metrics(onlineDeparture?[...timeline,onlineDeparture]:timeline);
  if(total>1&&m.status==='delivered'&&!allDelivered)m.status='partial';
  return{...s,t6_tracking,events:timeline,metrics:m,package_group:total?{total,packages,allDelivered,delivered:packages.filter(p=>p.status==='delivered').length}:null};
 };
 function add(data) {
  const number=normalizeNumber(data.number); if(!/^[A-Z0-9-]{6,40}$/.test(number)) throw Error('单号应为 6–40 位字母、数字或连字符');
  const product=String(data.product||'').trim(); if(!product||product.length>200) throw Error('请填写产品名称（最多200字）');
  if(!['UPS','FedEx','DHL','Chronopost','DPD','其他'].includes(data.carrier)) throw Error('请选择承运商');
  if(data.carrier==='UPS'&&!/^1Z[A-Z0-9]{16}$/.test(number)) throw Error('UPS 单号应为 1Z 开头，共18位');
  const id=randomUUID();
  const details=shippingFields(data);
  if(data.attachment&&!db.prepare('SELECT id FROM attachments WHERE id=?').get(data.attachment)) throw Error('面单附件不存在');
  if(data.carrier_code && (!Number.isSafeInteger(Number(data.carrier_code))||Number(data.carrier_code)<1)) throw Error('承运商代码必须为正整数');
  const row={id,product,number,carrier:data.carrier,batch:String(data.batch||'').slice(0,100),destination:String(data.destination||'').slice(0,200),notes:String(data.notes||'').slice(0,2000),attachment:data.attachment||null,created:new Date().toISOString(),carrier_code:data.carrier_code?Number(data.carrier_code):null,sales_id:data.sales_id||null,sales_id_2:data.sales_id_2||null,created_by:data.created_by||null,enabled:1,...details,paid_at:details.payment_status==='paid'?new Date().toISOString():null,paid_by:details.payment_status==='paid'?(data.created_by||null):null};
  if(data.inbound_customer)row.inbound_customer=data.inbound_customer;
  const keys=Object.keys(row);db.prepare(`INSERT INTO shipments(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
  return get(id);
 }
 function ingest(id, input, raw=null) {
  if(!get(id)) throw Error('运单不存在');
  if(!Array.isArray(input)||input.length>1000) throw Error('轨迹格式错误或超过1000条');
  const clean=input.map(e=>{
   if(!validTime(e.time)||!Object.hasOwn(labels,e.kind)||!e.description||!e.source) throw Error('每条轨迹需包含时区时间、有效状态、描述及来源');
   if(Date.parse(e.time)>Date.now()+300000) throw Error('轨迹时间不能晚于当前时间');
   return {time:new Date(e.time).toISOString(),kind:e.kind,description:String(e.description).slice(0,2000),location:String(e.location||'').slice(0,300),source:String(e.source).slice(0,150)};
  });
  const before=metrics(events(id)); let count=0; const addedKinds=new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
   for(const e of clean) {
    const hash=createHash('sha256').update(JSON.stringify([id,e.time,e.kind,e.description,e.location,e.source])).digest('hex');
    const result=db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?)').run(hash,id,e.time,e.kind,e.description,e.location,e.source,new Date().toISOString());
    if(result.changes){count++;addedKinds.add(e.kind);}
   }
   if(raw) db.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run(randomUUID(),id,JSON.stringify(raw),new Date().toISOString());
   const after=metrics(events(id));
   if(count && (before.status!==after.status||['pickup','cleared','out','delivered','exception'].some(k=>addedKinds.has(k)))) {
    const total=get(id).package_total||0;
    const title=after.status==='delivered'&&total>1?`主查箱号已签收，请核对整票${total}箱`:before.status!==after.status?labels[after.status]:'新增物流节点：'+[...addedKinds].map(k=>labels[k]).join('、');
    db.prepare('INSERT INTO notifications VALUES(?,?,?,?,0)').run(randomUUID(),id,title,new Date().toISOString());
   }
   db.exec('COMMIT'); return {count,shipment:get(id)};
  } catch(e){db.exec('ROLLBACK');throw e;}
 }
 return {db,events,get,add,ingest,list:()=>db.prepare('SELECT id FROM shipments WHERE deleted_at IS NULL ORDER BY created DESC').all().map(s=>get(s.id))};
}
