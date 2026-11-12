import {randomBytes,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
export const roles=['ADMIN','LOGISTICS','SALES'];
export function passwordHash(password){
 if(typeof password!=='string'||password.length<12||password.length>256)throw Error('密码需为12–256位');
 const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');
}
export function verifyPassword(password,encoded){try{if(typeof password!=='string'||password.length>256)return false;const[salt,hex]=encoded.split(':');const expected=Buffer.from(hex,'hex'),actual=scryptSync(password,salt,64);return actual.length===expected.length&&timingSafeEqual(actual,expected);}catch{return false;}}
export function publicUser(u){return u?{id:u.id,username:u.username,name:u.name,role:u.role,active:!!u.active,created:u.created}:null;}
export function accounts(store){
 const db=store.db;
 function bootstrap(encoded){
  if(db.prepare('SELECT count(*) n FROM users').get().n)return;
  if(!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded||''))throw Error('首次启动需配置 ADMIN_PASSWORD_HASH；运行 node scripts/password.mjs 生成');
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),'admin','ADMIN','ADMIN',encoded,1,new Date().toISOString(),null);
 }
 function create(data,actor){
  const username=String(data.username||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username))throw Error('账号需为3–40位字母、数字、点、下划线或连字符');
  const name=String(data.name||'').trim();if(!name||name.length>80)throw Error('请填写姓名（最多80字）');
  if(!roles.includes(data.role))throw Error('账户角色无效');
  const encoded=passwordHash(data.password),id=randomUUID();
  db.exec('BEGIN IMMEDIATE');try{
   db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(id,username,name,data.role,encoded,1,new Date().toISOString(),actor);
   audit(actor,'account.create',id,{username,role:data.role});db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');if(e.code==='ERR_SQLITE_ERROR')throw Error('账号已存在或保存失败');throw e;}
  return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
 }
 function update(id,data,actor){
  const current=db.prepare('SELECT * FROM users WHERE id=?').get(id);if(!current)throw Error('账户不存在');
  const name=String(data.name??current.name).trim(),role=data.role??current.role,active=data.active===undefined?!!current.active:data.active;
  if(!name||name.length>80||!roles.includes(role)||typeof active!=='boolean')throw Error('账户姓名、角色或状态无效');
  const encoded=data.password?passwordHash(data.password):current.password_hash;
  db.exec('BEGIN IMMEDIATE');try{
   if(current.role==='ADMIN'&&current.active&&(!active||role!=='ADMIN')&&db.prepare("SELECT count(*) n FROM users WHERE role='ADMIN' AND active=1").get().n<=1)throw Error('必须保留至少一个启用的 ADMIN');
   if(current.role==='SALES'&&role!=='SALES'&&db.prepare('SELECT count(*) n FROM shipments WHERE sales_id=?').get(id).n)throw Error('此销售仍有归属运单，请先重新分配后再更改角色');
   db.prepare('UPDATE users SET name=?,role=?,active=?,password_hash=? WHERE id=?').run(name,role,active?1:0,encoded,id);
   // Account edits invalidate all prior sessions, including role changes and password reset.
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
   audit(actor,'account.update',id,{name,role,active,passwordReset:!!data.password});db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
 }
 function audit(actor,action,target,detail){db.prepare('INSERT INTO audit_log VALUES(?,?,?,?,?,?)').run(randomUUID(),actor,action,target,JSON.stringify(detail),new Date().toISOString());}
 function sales(id){const u=db.prepare("SELECT * FROM users WHERE id=? AND role='SALES' AND active=1").get(String(id||''));if(!u)throw Error('请选择一个启用的销售账户');return u;}
 return{bootstrap,create,update,audit,sales,list:()=>db.prepare('SELECT * FROM users ORDER BY created').all().map(publicUser)};
}
