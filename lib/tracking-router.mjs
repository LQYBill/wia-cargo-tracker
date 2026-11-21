import {queryT6} from './t6.mjs';

// Both the nightly queue and manual sync use this provider.
export function createTrackingRouter(store,website,{query=queryT6,clock=Date.now}={}){
 let active=null;
 async function sync(id){
  if(active)throw Error('已有官网查询正在运行');
  const shipment=store.get(id);if(!shipment||shipment.deleted_at)throw Error('运单不存在');
  if(shipment.metrics.status==='delivered')return {count:0,skipped:true,reason:'已签收，不再查询'};
  if(!shipment.transfer_number?.trim()||shipment.freight_company==='MBS')return website.sync(id);
  const company=shipment.freight_company,number=shipment.transfer_number.trim();
  const configured=store.db.prepare('SELECT tracking_url FROM freight_companies WHERE name=?').get(company);
  const site=company==='纽欧'?'niuku':/yf\.t6soft\.com/.test(configured?.tracking_url||'')||/亿丰/.test(company)?'t6':null;
  if(!site)throw Error('此物流商的内部单号查询网页尚未配置');
  active=id;const attempted=new Date(clock()).toISOString();
  store.db.prepare('UPDATE shipments SET last_attempt=? WHERE id=?').run(attempted,id);
  try{
   const result=await query(number,site);
   if(!result.events?.length)throw Error('物流商网页未返回可验证轨迹');
   const prior=store.db.prepare('SELECT * FROM t6_checks WHERE shipment=?').get(id);
   const previous=prior?.company===company&&prior?.number===number?JSON.parse(prior.events||'[]'):[];
   const events=new Map(previous.map(e=>[JSON.stringify([e.time,e.description]),e]));let count=0;
   for(const event of result.events){const key=JSON.stringify([event.time,event.description]);if(!events.has(key)){events.set(key,event);count++;}}
   const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris'}).format(new Date(clock()));
   store.db.prepare(`INSERT INTO t6_checks(shipment,company,number,day,checked_at,events,error) VALUES(?,?,?,?,?,?,NULL)
    ON CONFLICT(shipment) DO UPDATE SET company=excluded.company,number=excluded.number,day=excluded.day,checked_at=excluded.checked_at,events=excluded.events,error=NULL`)
    .run(id,company,number,day,attempted,JSON.stringify([...events.values()].sort((a,b)=>b.time.localeCompare(a.time))));
   store.db.prepare('UPDATE shipments SET last_sync=?,error=NULL,query_warning=? WHERE id=?').run(attempted,count?null:'暂无新轨迹',id);
   return {count,source:site};
  }catch(error){store.db.prepare('UPDATE shipments SET error=? WHERE id=?').run(error.message,id);throw error;}
  finally{active=null;}
 }
 return {sync,check:()=>website.check(),connection:()=>website.connection(),isBusy:()=>!!active||website.isBusy(),isSyncing:id=>active===id||website.isSyncing(id),close:()=>website.close()};
}
