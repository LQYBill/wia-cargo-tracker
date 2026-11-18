import {calendarDay} from './nightly.mjs';

const origin='https://yf.t6soft.com';
const source='亿丰国际 T6';
const niukuUrl='https://erp.usniuku.com/search/';

export async function queryT6(number,site='t6'){
 const {chromium}=await import('playwright');
 const channel=process.env.TRACKING_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined);
 const browser=await chromium.launch({headless:true,chromiumSandbox:process.platform!=='win32',channel});
 try{
  const page=await browser.newPage(site==='niuku'?{timezoneId:'Europe/Paris'}:{});
  if(site==='niuku'){
   await page.goto(niukuUrl,{waitUntil:'domcontentloaded',timeout:45000});
   await page.getByRole('textbox').fill(number);
   await page.getByRole('button',{name:'查询(TRACK)'}).click();
   await page.getByText(number,{exact:true}).waitFor({timeout:25000});
   const rows=page.getByRole('row').filter({hasText:/^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/});
   await rows.first().waitFor({timeout:25000});
   const events=await rows.evaluateAll(items=>items.flatMap(row=>{
    const [time,description]=Array.from(row.cells,cell=>cell.innerText.trim());
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time)&&description?[{time:time+':00',description}]:[];
   }));
   if(!events.length)throw Error('未取得纽欧轨迹');
   return {source:'纽欧',events};
  }
  await page.goto(origin+'/track',{waitUntil:'load',timeout:45000});
  await page.locator('#waybillnumber').fill(number);
  await page.locator('#searchBtn').click();
  await page.getByText(number,{exact:true}).first().waitFor({timeout:25000});
  await page.locator('.trackdate').first().waitFor({timeout:25000});
  const events=await page.locator('.trackdate').evaluateAll(nodes=>nodes.map(node=>({
   time:node.textContent.trim(),description:node.parentElement.querySelector('.trackinfo')?.textContent.trim()
  })).filter(event=>event.description));
  if(!events.length)throw Error('未取得轨迹');
  return {source,events:[...new Map(events.map(event=>[JSON.stringify(event),event])).values()]};
 }finally{await browser.close();}
}

export function createT6Monitor(db,{clock=Date.now,query=queryT6}={}){
 let running=null,stopped=false;
 const next=db.prepare(`SELECT s.id,s.freight_company,COALESCE(NULLIF(TRIM(s.transfer_number),''),s.number) AS number,
  CASE WHEN s.freight_company='纽欧' THEN 'niuku' ELSE 't6' END AS site
  FROM shipments s LEFT JOIN freight_companies c ON c.name=s.freight_company
  LEFT JOIN t6_checks t ON t.shipment=s.id
  WHERE s.deleted_at IS NULL AND (? IS NOT NULL AND s.id=? OR ? IS NULL AND (s.enabled=1 OR NULLIF(TRIM(s.transfer_number),'') IS NOT NULL))
  AND (s.freight_company='纽欧' AND NULLIF(TRIM(s.transfer_number),'') IS NOT NULL OR c.tracking_url IN (?,?))
  AND (? IS NOT NULL OR t.day IS NULL OR t.day<>? OR t.number<>COALESCE(NULLIF(TRIM(s.transfer_number),''),s.number)) ORDER BY s.id LIMIT 1`);
 const claim=db.prepare(`INSERT INTO t6_checks VALUES(?,?,?,?,?,NULL,?)
  ON CONFLICT(shipment) DO UPDATE SET day=excluded.day,checked_at=excluded.checked_at,
   events=CASE WHEN t6_checks.company=excluded.company AND t6_checks.number=excluded.number THEN t6_checks.events END,
   company=excluded.company,number=excluded.number,error=excluded.error
  `);
 return {
  async tick(shipmentId=null){
   if(stopped)return;
   if(running){if(!shipmentId)return;await running;}
   const now=clock(), local=calendarDay(now,'Europe/Paris');
   if(!shipmentId&&local.hour<22)return;
   const shipment=next.get(shipmentId,shipmentId,shipmentId,origin+'/track','http://yf.t6soft.com/track',shipmentId,local.date);
   if(!shipment)return;
   const {id,freight_company:company,number}=shipment;
   const checkedAt=new Date(now).toISOString();
   if(!claim.run(id,company,number,local.date,checkedAt,'查询未完成').changes)return;
   const task=(async()=>{
   try{
    const result=await query(number,shipment.site);
    const previous=db.prepare('SELECT events FROM t6_checks WHERE shipment=? AND company=? AND number=?').get(id,company,number);
    const events=new Map();
    for(const event of [...JSON.parse(previous?.events||'[]'),...result.events]){
     const key=JSON.stringify([event.time,event.description]);
     if(!events.has(key))events.set(key,event);
    }
    const merged=[...events.values()].sort((a,b)=>b.time.localeCompare(a.time));
    db.prepare('UPDATE t6_checks SET events=?,error=NULL WHERE shipment=? AND company=? AND number=?').run(JSON.stringify(merged),id,company,number);
   }catch(error){
    db.prepare('UPDATE t6_checks SET error=? WHERE shipment=?').run(error.message,id);
   }
   })();
   running=task;
   try{await task;return true;}finally{running=null;}
  },
  async stop(){stopped=true;while(running)await new Promise(resolve=>setTimeout(resolve,20));}
 };
}
