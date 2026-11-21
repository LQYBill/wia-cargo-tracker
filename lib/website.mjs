import{parseUpsPage,parse17Page,websiteKind}from'./website-parser.mjs';
import{randomUUID}from'node:crypto';
export function createWebsiteProvider(store,{launch,clock=()=>Date.now()}={}){
 let active=null,ready=false,setupError=null,currentBrowser=null,closing=false;
 const previous=store.list().filter(s=>s.last_attempt).sort((a,b)=>Date.parse(b.last_attempt)-Date.parse(a.last_attempt))[0];
 let siteState=previous?.error?'blocked':'unverified',siteError=previous?.error||null;
 async function browser(){
  if(closing)throw Error('查询服务正在停止');
  if(launch)return launch();
  let chromium;try{({chromium}=await import('playwright'));}catch{throw Error('官网查询组件未安装，请由IT执行 npm ci 和 npx playwright install chromium');}
  try{return await chromium.launch({headless:true,chromiumSandbox:process.platform!=='win32',...(process.env.TRACKING_BROWSER_CHANNEL||process.platform==='win32'?{channel:process.env.TRACKING_BROWSER_CHANNEL||'msedge'}:{})});}catch{throw Error('浏览器未就绪，请由IT安装Chromium及系统依赖，不能确认已自动监控');}
 }
 async function check(){let b;try{b=await browser();ready=true;setupError=null;}catch(e){ready=false;setupError=e.message;}finally{await b?.close();}return{ready,error:setupError};}
 async function pageRead(context,url,site,number){
  const page=await context.newPage();let responseInfo=null;page.on('response',r=>{if(r.request().isNavigationRequest()&&r.frame()===page.mainFrame())responseInfo={status:r.status(),type:r.headers()['content-type']||''};});try{
   const navigation=await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
   if(navigation&&navigation.status()>=400)throw Error('官网返回HTTP '+navigation.status()+'，未取得物流页面');
   if(site==='UPS'){
    const reject=page.getByRole('button',{name:'Essential Cookies Only',exact:true});if(await reject.isVisible().catch(()=>false))await reject.click();
    await page.locator('#showDetailButton').waitFor({state:'visible',timeout:40000});
    if(/Show Details/i.test(await page.locator('#showDetailButton').innerText()))await page.locator('#showDetailButton').click();
    await page.locator('#shipProg_View').waitFor({state:'visible',timeout:20000});
    const body=await page.locator('body').innerText(),history=await page.locator('#shipProg_View').innerText();
    const events=parseUpsPage({number,body,history});const count=Number(body.match(/\d+ of (\d+) Piece Shipment/)?.[1]||1),packages=[];
    const group=page.getByRole('button',{name:'All Parcels in this Shipment',exact:true});
    if(count>1&&await group.isVisible().catch(()=>false)){
     await group.click();
     for(let p=0;p<20;p++){
      const links=page.locator('[id^="stApp_stApp_namecard_TV_trkNum"]');await links.first().waitFor({state:'visible',timeout:15000});
      const all=await page.locator('body').innerText(),numbers=await links.allTextContents();
      for(let i=0;i<numbers.length;i++){const n=numbers[i].trim(),position=all.indexOf(n,all.indexOf('All Parcels in this Shipment')),tail=all.slice(position+n.length);const description=tail.split(/\b1Z[A-Z0-9]{16}\b/)[0].split('Latest Update:')[0].trim();if(!packages.some(x=>x.number===n))packages.push({number:n,status:websiteKind(description),description,checked_at:new Date(clock()).toISOString()});}
      const next=page.locator('#stApp_pagination_nextBtn');if(!await next.isVisible().catch(()=>false)||!await next.isEnabled())break;
      const old=numbers.join(',');await next.click();await page.waitForFunction(old=>Array.from(document.querySelectorAll('[id^="stApp_stApp_namecard_TV_trkNum"]')).map(x=>x.textContent.trim()).join(',')!==old&&document.querySelector('[id^="stApp_stApp_namecard_TV_trkNum"]'),old,{timeout:20000});
     }
    }
    return{site,url,events,count,packages,checked_at:new Date(clock()).toISOString()};
   }
   await page.getByText(number,{exact:true}).first().waitFor({state:'visible',timeout:45000});
   const details=page.getByRole('heading',{name:'Tracking Information',exact:true});
   if(!await details.isVisible()){
    const expand=page.locator('button[aria-expanded="false"]').filter({hasText:/^\s*$/}).first();
    if(await expand.isVisible())await expand.click();
   }
   await page.getByRole('heading',{name:'Tracking Information',exact:true}).waitFor({state:'visible',timeout:30000});
   const body=await page.locator('body').innerText();return{site,url,events:parse17Page({number,body}),checked_at:new Date(clock()).toISOString()};
  }catch(e){
   const reason=/Download is starting/i.test(e.message)?'官网返回下载响应，未取得物流网页':/Timeout/i.test(e.message)?'官网请求超时，未取得可读轨迹，可能需要验证码或被限流':e.message.replace(/\u001b\[[0-9;]*m/g,'').split('Call log:')[0].trim();
   const error=new Error(reason);error.responseInfo={...responseInfo,title:await page.title().catch(()=>''),excerpt:(await page.locator('body').innerText({timeout:1000}).catch(()=>'')).slice(0,800)};throw error;
  }finally{await page.close();}
 }
 async function sync(id){
  if(active)throw Error('已有官网查询正在运行');const shipment=store.get(id);if(!shipment||shipment.deleted_at)throw Error('运单不存在');active=id;
  const attempted=new Date(clock()).toISOString();store.db.prepare('UPDATE shipments SET last_attempt=? WHERE id=?').run(attempted,id);
  let b;const checks=[];try{
   b=await browser();currentBrowser=b;ready=true;setupError=null;const context=await b.newContext({locale:'en-GB',timezoneId:'Europe/Paris'});
   for(const [site,url]of [['17TRACK',`https://t.17track.net/en#nums=${encodeURIComponent(shipment.number)}`]]){
    if(site==='UPS'&&shipment.carrier!=='UPS')continue;
    try{checks.push(await pageRead(context,url,site,shipment.number));}catch(e){checks.push({site,url,error:e.message,response:e.responseInfo||null,checked_at:new Date(clock()).toISOString()});}
   }
   const primary=checks.find(c=>c.site==='UPS'&&!c.error)||checks.find(c=>!c.error);if(!primary)throw Error(checks.map(c=>c.site+': '+c.error).join('；'));
   const officialLabel=checks.find(c=>c.site==='UPS'&&!c.error)?.events.find(e=>e.kind==='label')?.time,otherLabel=checks.find(c=>c.site==='17TRACK'&&!c.error)?.events.find(e=>e.kind==='label')?.time;
   const warning=officialLabel&&otherLabel&&officialLabel!==otherLabel?'两平台建单时间不一致，采用快递官网时间，需人工核验':checks.some(c=>c.error)?'部分来源查询失败：'+checks.filter(c=>c.error).map(c=>c.site).join('、'):null;
   if(primary.count>1)store.db.prepare('UPDATE shipments SET package_total=? WHERE id=?').run(primary.count,id);
   // The same scan can have different wording/source after a manual webpage import.
   const existing=store.db.prepare('SELECT time,kind FROM events WHERE shipment=?').all(id);
   const seen=new Set(existing.map(e=>JSON.stringify([Date.parse(e.time),e.kind])));
   const fresh=primary.events.filter(e=>{const key=JSON.stringify([Date.parse(e.time),e.kind]);if(seen.has(key))return false;seen.add(key);return true;});
   const result=store.ingest(id,fresh,{method:'scheduled_website_browser',checks});
   if(primary.packages?.length){store.db.prepare('UPDATE shipments SET package_total=? WHERE id=?').run(primary.count,id);const upsert=store.db.prepare('INSERT INTO package_tracks(shipment,number,status,description,checked_at) VALUES(?,?,?,?,?) ON CONFLICT(shipment,number) DO UPDATE SET status=excluded.status,description=excluded.description,checked_at=excluded.checked_at');for(const p of primary.packages)upsert.run(id,p.number,p.status,p.description,p.checked_at);const group=store.get(id).package_group;if(group.total>1&&group.delivered>0&&group.delivered!==(shipment.package_group?.delivered||0))store.db.prepare('INSERT INTO notifications VALUES(?,?,?,?,0)').run(randomUUID(),id,group.allDelivered?`整票全部${group.total}箱已签收`:`整票箱状态更新：已签收${group.delivered}/${group.total}箱`,new Date(clock()).toISOString());}
   store.db.prepare('UPDATE shipments SET last_sync=?,error=NULL,query_warning=? WHERE id=?').run(attempted,warning,id);
   siteState=checks.some(c=>c.error)?'partial':'connected';siteError=warning;
   return{...result,warning,checks:checks.map(c=>({site:c.site,error:c.error||null}))};
  }catch(e){siteState='blocked';siteError=e.message;store.db.prepare('UPDATE shipments SET error=? WHERE id=?').run(e.message,id);store.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run(randomUUID(),id,JSON.stringify({method:'failed_website_query',checks,error:e.message}),new Date(clock()).toISOString());throw e;}finally{await b?.close().catch(()=>{});active=null;currentBrowser=null;}
 }
 return{sync,check,isSyncing:id=>active===id,isBusy:()=>!!active,connection:()=>({ready,error:setupError,siteState,siteError,source:'website'}),close:async()=>{closing=true;await currentBrowser?.close().catch(()=>{});}};
}
