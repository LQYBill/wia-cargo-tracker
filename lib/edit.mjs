import {randomUUID} from 'node:crypto';
import {normalizeNumber} from './model.mjs';
import {shippingFields} from './shipping.mjs';
export function editShipment(store,users,id,b,user){
 const existing=store.get(id);if(!existing||existing.deleted_at)throw Error('运单不存在');
 const product=String(b.product??existing.product).trim();if(!product||product.length>200)throw Error('产品名称需为1–200字');
 const number=normalizeNumber(b.number??existing.number),carrier=b.carrier??existing.carrier;
 if(!/^[A-Z0-9-]{6,40}$/.test(number))throw Error('单号应为6–40位字母、数字或连字符');
 if(!['UPS','FedEx','DHL','Chronopost','DPD','其他'].includes(carrier))throw Error('请选择承运商');
 if(carrier==='UPS'&&!/^1Z[A-Z0-9]{16}$/.test(number))throw Error('UPS单号应为1Z开头，共18位');
 const duplicate=store.db.prepare('SELECT id FROM shipments WHERE number=? AND id<>?').get(number,id);if(duplicate)throw Error('单号已存在（包括回收站），不能重复保存');
 const owner=(Object.hasOwn(b,'sales_id')?b.sales_id:existing.sales_id)||null;
 if(owner!==existing.sales_id||owner){const u=store.db.prepare("SELECT id FROM users WHERE id=? AND role='SALES'").get(owner);if(!u)throw Error('归属销售不存在');if(owner!==existing.sales_id)users.sales(owner);}
 const attachment=Object.hasOwn(b,'attachment')?b.attachment:existing.attachment;
 if(!attachment&&existing.attachment&&user.role!=='ADMIN')throw Error('物流专员可替换面单，不能移除面单');
 if(attachment&&!store.db.prepare('SELECT id FROM attachments WHERE id=?').get(attachment))throw Error('面单附件不存在');
 let code=Object.hasOwn(b,'carrier_code')?b.carrier_code:existing.carrier_code;code=code===''||code===null?null:Number(code);
 if(code!==null&&(!Number.isSafeInteger(code)||code<1))throw Error('承运商代码必须为正整数');
 const identityChanged=number!==existing.number||carrier!==existing.carrier||code!==existing.carrier_code;
 const second=(Object.hasOwn(b,'sales_id_2')?b.sales_id_2:existing.sales_id_2)||null;
 if(second&&second===owner)throw Error('请选择两位不同的销售');
 if(second&&second!==existing.sales_id_2)users.sales(second);
 const row={product,number,carrier,carrier_code:code,batch:String(b.batch??existing.batch).slice(0,100),destination:String(b.destination??existing.destination).slice(0,200),notes:String(b.notes??existing.notes).slice(0,2000),sales_id:owner||null,sales_id_2:second,attachment:attachment||null,...shippingFields(b,existing)};
 if(row.payment_status!==existing.payment_status)Object.assign(row,{paid_at:row.payment_status==='paid'?new Date().toISOString():null,paid_by:row.payment_status==='paid'?user.id:null});
 store.db.exec('BEGIN IMMEDIATE');try{
  if(identityChanged){
   const snapshots=store.db.prepare('SELECT * FROM snapshots WHERE shipment=?').all(id),notifications=store.db.prepare('SELECT * FROM notifications WHERE shipment=?').all(id);
   store.db.prepare('INSERT INTO tracking_archives VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,existing.number,existing.carrier,JSON.stringify({events:existing.events,snapshots,notifications}),new Date().toISOString(),user.id);
   store.db.prepare('DELETE FROM notification_reads WHERE notification IN (SELECT id FROM notifications WHERE shipment=?)').run(id);
   for(const table of ['notifications','events','snapshots'])store.db.prepare(`DELETE FROM ${table} WHERE shipment=?`).run(id);
   store.db.prepare('DELETE FROM package_tracks WHERE shipment=?').run(id);
   Object.assign(row,{registered:0,last_sync:null,error:null,next_sync:0,enabled:0,package_total:null,last_attempt:null,query_warning:null});
  }
  store.db.prepare(`UPDATE shipments SET ${Object.keys(row).map(k=>k+'=?').join(',')} WHERE id=?`).run(...Object.values(row),id);
  users.audit(user.id,'shipment.edit',id,{previous_sales_id:existing.sales_id,sales_id:owner,previous_sales_id_2:existing.sales_id_2,sales_id_2:second,previous_number:existing.number,number,identityChanged,previous:existing});
  store.db.exec('COMMIT');return {ok:true,identityChanged};
 }catch(e){store.db.exec('ROLLBACK');throw e;}
}
