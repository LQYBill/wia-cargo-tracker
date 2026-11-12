import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {openStore} from './lib/store.mjs';
import {createProvider} from './lib/provider.mjs';
import {readLabel} from './lib/ocr.mjs';
import {accounts,publicUser,verifyPassword} from './lib/accounts.mjs';
import {fileType,publicShipment} from './lib/shipping.mjs';
import {editShipment} from './lib/edit.mjs';
import {createWebsiteProvider} from './lib/website.mjs';
import {createNightly} from './lib/nightly.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const dir=resolve(process.env.CARGO_DATA_DIR||join(root,'data'));
const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||5187),origin=process.env.APP_ORIGIN||`http://localhost:${port}`;
const secure=origin.startsWith('https:');
const store=openStore(dir),trackingSource=process.env.TRACKING_SOURCE||'website';
const provider=trackingSource==='website'?createWebsiteProvider(store):createProvider(store);
const nightly=trackingSource==='website'?createNightly(store,provider):null;
if(nightly)await provider.check();
const users=accounts(store);users.bootstrap(process.env.ADMIN_PASSWORD_HASH);
await mkdir(join(dir,'labels'),{recursive:true,mode:0o700});
const hash=s=>createHash('sha256').update(s).digest('hex');
const attempts=new Map();let ocrBusy=false;
function session(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('cargo_session='))?.slice(14);return token&&store.db.prepare('SELECT s.token,u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires>? AND u.active=1').get(hash(token),Date.now());}
const canWrite=u=>u.role==='ADMIN'||u.role==='LOGISTICS';
const canSee=(u,s)=>!!s&&!s.deleted_at&&(canWrite(u)||s.sales_id===u.id);
function canSeeLabel(u,id){return canWrite(u)||!!store.db.prepare('SELECT id FROM shipments WHERE sales_id=? AND attachment=? AND deleted_at IS NULL').get(u.id,id);}
function notices(u){return store.db.prepare(`SELECT n.id,n.shipment,n.title,n.created,s.product,s.number,CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END AS read FROM notifications n JOIN shipments s ON n.shipment=s.id LEFT JOIN notification_reads r ON r.notification=n.id AND r.user_id=? WHERE s.deleted_at IS NULL AND (? != 'SALES' OR s.sales_id=?) ORDER BY n.created DESC LIMIT 200`).all(u.id,u.role,u.id);}
async function body(req,max=12*1024*1024){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('请求过大');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('JSON 格式错误');}}
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 try {
  const path=new URL(req.url,'http://localhost').pathname;
  if(!['GET','POST'].includes(req.method))return json(res,{error:'方法不支持'},405);
  if(req.method==='POST'&&req.headers.origin!==origin)return json(res,{error:'来源校验失败，请使用 APP_ORIGIN 配置的地址访问'},403);
  if(path==='/health')return json(res,{ok:true});
  if(path==='/api/login'&&req.method==='POST') {
   const ip=req.socket.remoteAddress||'local';const record=attempts.get(ip)||{count:0,start:Date.now()};
   if(Date.now()-record.start>900000){record.count=0;record.start=Date.now();}attempts.set(ip,record);
   if(record.count>=10)return json(res,{error:'尝试次数过多，15分钟后重试'},429);
   const b=await body(req,8192);const username=String(b.username||'').trim().toLowerCase();
   const user=store.db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
   const encoded=user?.password_hash||'00000000000000000000000000000000:'+ '00'.repeat(64);
   if(!verifyPassword(b.password,encoded)||!user){record.count++;return json(res,{error:'账号或密码不正确，或账号已停用'},401);}attempts.delete(ip);
   const token=randomBytes(32).toString('hex');store.db.prepare('INSERT INTO sessions(token,expires,user_id) VALUES(?,?,?)').run(hash(token),Date.now()+43200000,user.id);
   res.setHeader('Set-Cookie',`cargo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure?'; Secure':''}`);return json(res,{ok:true});
  }
  if(path.startsWith('/api/')||path.startsWith('/labels/')) {
   const user=session(req);if(!user)return json(res,{error:'请先登录'},401);
   if(req.method==='POST'&&user.role==='SALES'&&!['/api/logout','/api/notifications/read'].includes(path))return json(res,{error:'销售账户仅可查看自己的物流'},403);
   if(path==='/api/users'){
    if(user.role!=='ADMIN')return json(res,{error:'仅 ADMIN 可管理账户'},403);
    if(req.method==='GET')return json(res,{users:users.list()});
    return json(res,users.create(await body(req,8192),user.id),201);
   }
   const accountPath=path.match(/^\/api\/users\/([a-f0-9-]{36})$/);
   if(accountPath&&req.method==='POST'){
    if(user.role!=='ADMIN')return json(res,{error:'仅 ADMIN 可管理账户'},403);
    return json(res,users.update(accountPath[1],await body(req,8192),user.id));
   }
   if(path==='/api/logout'&&req.method==='POST') {const s=session(req);store.db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);res.setHeader('Set-Cookie','cargo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,{ok:true});}
   if(path==='/api/monitor'&&req.method==='GET'){
    if(!canWrite(user))return json(res,{error:'无权查看监控运行记录'},403);return json(res,nightly?.state()||{source:'api'});
   }
   if(path==='/api/monitor/run'&&req.method==='POST'){
    if(!nightly)throw Error('当前未启用官网夜间监控');const id=nightly.enqueue();setImmediate(()=>nightly.tick().catch(()=>{}));return json(res,{queued:true,id});
   }
   if(path==='/api/trash'&&req.method==='GET'){
    if(user.role!=='ADMIN')return json(res,{error:'仅 ADMIN 可查看回收站'},403);
    return json(res,{shipments:store.db.prepare('SELECT id,product,number,deleted_at FROM shipments WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all()});
   }
   const lifecycle=path.match(/^\/api\/shipments\/([a-f0-9-]{36})\/(delete|restore)$/);
   if(lifecycle&&req.method==='POST'){
    if(user.role!=='ADMIN')return json(res,{error:'仅 ADMIN 可删除或恢复运单'},403);
    const [,id,action]=lifecycle,s=store.get(id);if(!s)return json(res,{error:'运单不存在'},404);
    const b=await body(req,8192);if(action==='delete'&&b.confirm_number!==s.number)throw Error('请填写正确的运单号确认删除');
    if(provider.isSyncing(id))throw Error('此票正在同步，请同步完成后重试');
    if(action==='delete'&&s.deleted_at)throw Error('运单已在回收站');if(action==='restore'&&!s.deleted_at)throw Error('运单未删除');
    store.db.exec('BEGIN IMMEDIATE');try{
     store.db.prepare('UPDATE shipments SET deleted_at=?,deleted_by=?,enabled=0 WHERE id=?').run(action==='delete'?new Date().toISOString():null,action==='delete'?user.id:null,id);
     users.audit(user.id,'shipment.'+action,id,{number:s.number});store.db.exec('COMMIT');
    }catch(e){store.db.exec('ROLLBACK');throw e;}return json(res,{ok:true});
   }
   if(path==='/api/state'&&req.method==='GET'){
    const directory=canWrite(user)?users.list().filter(u=>u.role==='SALES'):[];
    const shipments=store.list().filter(s=>canSee(user,s)).map(s=>{
     const owner=store.db.prepare('SELECT name,username FROM users WHERE id=?').get(s.sales_id||'');
     const result={...s,sales_name:owner?.name||'未分配销售',sales_username:owner?.username||''};
     result.documents=store.db.prepare('SELECT id,kind,name,mime,size,created FROM documents WHERE shipment=? AND (?=1 OR kind=\'products\') ORDER BY created DESC').all(s.id,canWrite(user)?1:0);
     return canWrite(user)?result:publicShipment(result);
    });
    const monitor=nightly?.state();
    return json(res,{user:publicUser(user),sales:directory,shipments,notifications:notices(user),monitor:canWrite(user)?monitor:null,connection:canWrite(user)?nightly?{configured:monitor.ready,mode:monitor.siteState==='blocked'?'官网自动访问失败 · '+monitor.schedule:monitor.ready?'官网夜间监控 · '+monitor.schedule:'官网夜间计划已设置 · 浏览器尚未就绪',error:monitor.error}:{configured:!!process.env.TRACK17_TOKEN,mode:process.env.TRACK17_TOKEN?'17TRACK 定时同步（至少30分钟）':'官网查询 + 手动录入；自动同步未接通'}:{mode:'我的物流 · 由物流专员维护'},now:new Date().toISOString()});
   }
   if(path==='/api/shipments'&&req.method==='POST'){
    const b=await body(req);users.sales(b.sales_id);const s=store.add({...b,created_by:user.id});users.audit(user.id,'shipment.create',s.id,{sales_id:s.sales_id});return json(res,s,201);
   }
   if(path==='/api/notifications/read'&&req.method==='POST'){
    const insert=store.db.prepare('INSERT OR IGNORE INTO notification_reads VALUES(?,?)');
    for(const n of notices(user))insert.run(n.id,user.id);return json(res,{ok:true});
   }
   if(path==='/api/upload'&&req.method==='POST'){
    const b=await body(req);const bytes=Buffer.from(String(b.base64||''),'base64');
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if(!png&&!jpg||bytes.length>8*1024*1024)throw Error('仅支持8MB以内的 JPG / PNG 面单');
    const id=randomUUID();await writeFile(join(dir,'labels',id),bytes,{mode:0o600});store.db.prepare('INSERT INTO attachments(id,mime,created,uploaded_by) VALUES(?,?,?,?)').run(id,png?'image/png':'image/jpeg',new Date().toISOString(),user.id);
    return json(res,{id,url:'/labels/'+id});
   }
   const documentPath=path.match(/^\/api\/documents\/([a-f0-9-]{36})$/);
   if(documentPath&&req.method==='GET'){
    const doc=store.db.prepare('SELECT * FROM documents WHERE id=?').get(documentPath[1]);
    if(!doc||!canSee(user,store.get(doc.shipment))||(!canWrite(user)&&doc.kind!=='products'))return json(res,{error:'文件不存在'},404);
    res.writeHead(200,{'Content-Type':doc.mime,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(doc.name),'Cache-Control':'private, no-store'});
    return res.end(await readFile(join(dir,'labels',doc.file_id||doc.id)));
   }
   const documentReplace=path.match(/^\/api\/documents\/([a-f0-9-]{36})\/replace$/);
   if(documentReplace&&req.method==='POST'){
    const doc=store.db.prepare('SELECT * FROM documents WHERE id=?').get(documentReplace[1]);if(!doc||!canSee(user,store.get(doc.shipment)))return json(res,{error:'文件不存在'},404);
    const b=await body(req,24*1024*1024),name=String(b.name||'').replace(/[\\/\x00-\x1f\x7f]/g,'_').slice(0,180),bytes=Buffer.from(String(b.base64||''),'base64');
    if(!name||!bytes.length||bytes.length>16*1024*1024)throw Error('文件不能为空，且不能超过16MB');
    const mime=fileType(name,bytes);if(doc.kind==='products'&&!/\.(xlsx|xls)$/i.test(name))throw Error('产品表仅支持 XLS / XLSX');
    const fileId=randomUUID();await writeFile(join(dir,'labels',fileId),bytes,{mode:0o600});
    store.db.exec('BEGIN IMMEDIATE');try{
     store.db.prepare('INSERT INTO document_versions VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),doc.id,doc.file_id||doc.id,doc.name,doc.mime,doc.size,new Date().toISOString(),user.id);
     store.db.prepare('UPDATE documents SET name=?,mime=?,size=?,file_id=? WHERE id=?').run(name,mime,bytes.length,fileId,doc.id);
     users.audit(user.id,'document.replace',doc.shipment,{document_id:doc.id});store.db.exec('COMMIT');
    }catch(e){store.db.exec('ROLLBACK');throw e;}return json(res,{ok:true});
   }
   const documentUpload=path.match(/^\/api\/shipments\/([a-f0-9-]{36})\/documents$/);
   if(documentUpload&&req.method==='POST'){
    const id=documentUpload[1];if(!canSee(user,store.get(id)))return json(res,{error:'运单不存在'},404);
    const b=await body(req,24*1024*1024);if(!['invoice','products'].includes(b.kind))throw Error('文件分类无效');
    const name=String(b.name||'').normalize('NFC').replace(/[\\/\x00-\x1f\x7f]/g,'_').slice(0,180);
    const bytes=Buffer.from(String(b.base64||''),'base64');if(!name||!bytes.length||bytes.length>16*1024*1024)throw Error('文件不能为空，且不能超过16MB');
    const mime=fileType(name,bytes);if(b.kind==='products'&&!/\.(xlsx|xls)$/i.test(name))throw Error('产品表仅支持 XLS / XLSX');
    const docId=randomUUID();await writeFile(join(dir,'labels',docId),bytes,{mode:0o600});
    store.db.prepare('INSERT INTO documents(id,shipment,kind,name,mime,size,created,uploaded_by) VALUES(?,?,?,?,?,?,?,?)').run(docId,id,b.kind,name,mime,bytes.length,new Date().toISOString(),user.id);
    users.audit(user.id,'document.upload',id,{document_id:docId,kind:b.kind});return json(res,{id:docId,name,kind:b.kind},201);
   }
   const label=path.match(/^\/labels\/([a-f0-9-]{36})$/);
   if(label&&req.method==='GET') {const a=store.db.prepare('SELECT * FROM attachments WHERE id=?').get(label[1]);if(!a||!canSeeLabel(user,label[1]))return json(res,{error:'附件不存在'},404);res.writeHead(200,{'Content-Type':a.mime,'Cache-Control':'private, no-store'});return res.end(await readFile(join(dir,'labels',a.id)));}
   const ocr=path.match(/^\/api\/ocr\/([a-f0-9-]{36})$/);
   if(ocr&&req.method==='POST') {if(ocrBusy)return json(res,{error:'面单识别正在进行，请稍后重试'},429);if(!store.db.prepare('SELECT id FROM attachments WHERE id=?').get(ocr[1]))throw Error('面单不存在');ocrBusy=true;try{return json(res,await readLabel(join(dir,'labels',ocr[1])));}finally{ocrBusy=false;}}
   const match=path.match(/^\/api\/shipments\/([a-f0-9-]{36})\/(events|sync|monitor|edit|payment)$/);
   if(match&&req.method==='POST') {
    const [,id,action]=match;const existing=store.get(id);if(!canSee(user,existing))return json(res,{error:'运单不存在'},404);
    if(action==='sync'){
     if(nightly){const job=nightly.enqueue(null,[id]);setImmediate(()=>nightly.tick().catch(()=>{}));return json(res,{queued:true,id:job});}
     return json(res,await provider.sync(id));
    }
    const b=await body(req);
    if(action==='payment'){
     if(!['unpaid','paid'].includes(b.payment_status))throw Error('付款状态只能为未付或已付');
     if(existing.payment_status===b.payment_status)return json(res,{ok:true});
     store.db.exec('BEGIN IMMEDIATE');try{
      store.db.prepare('UPDATE shipments SET payment_status=?,paid_at=?,paid_by=? WHERE id=?').run(b.payment_status,b.payment_status==='paid'?new Date().toISOString():null,b.payment_status==='paid'?user.id:null,id);
      users.audit(user.id,'shipment.payment',id,{before:existing.payment_status,after:b.payment_status});store.db.exec('COMMIT');
     }catch(e){store.db.exec('ROLLBACK');throw e;}return json(res,{ok:true});
    }
    if(action==='events')return json(res,store.ingest(id,b.events));
    if(action==='monitor'){if(b.enabled&&trackingSource!=='website'&&!process.env.TRACK17_TOKEN)throw Error('先配置 17TRACK 才能启用自动监控');store.db.prepare('UPDATE shipments SET enabled=? WHERE id=?').run(b.enabled?1:0,id);return json(res,{ok:true});}
    if(action==='edit'){
     if(provider.isSyncing(id))throw Error('此票正在同步，请同步完成后再编辑');
     return json(res,editShipment(store,users,id,b,user));
    }
   }
   return json(res,{error:'接口不存在'},404);
  }
  const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
  if(req.method==='GET'&&files[path]){const [file,mime]=files[path];res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache'});return res.end(await readFile(join(root,'public',file)));}
  json(res,{error:'页面不存在'},404);
 } catch(e){json(res,{error:e.code==='ERR_SQLITE_ERROR'?'单号已存在或数据写入失败':e.message},400);}
});
server.requestTimeout=120000;
server.listen(port,host,()=>console.log(`Cargo Tracker listening on ${host}:${port}; access ${origin}`));
const monitorTick=()=>nightly?nightly.tick():provider.tick();
const timer=setInterval(()=>monitorTick().catch(e=>console.error('Monitor task:',e.message)),10000);timer.unref();
setImmediate(()=>monitorTick().catch(e=>console.error('Monitor startup:',e.message)));
store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;clearInterval(timer);await provider.close?.();await nightly?.stop();server.close(()=>{store.db.close();process.exit(0);});});
