import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,cp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
if(!process.env.CARGO_DATA_DIR||!process.argv[2])throw Error('用法：CARGO_DATA_DIR=/绝对数据目录 node scripts/backup.mjs /新的空备份目录');
const src=resolve(process.env.CARGO_DATA_DIR),dest=resolve(process.argv[2]);
if(dest===src||dest.startsWith(src+'/')||dest.startsWith(src+'\\'))throw Error('备份目录不能位于数据目录内部');
await mkdir(dest,{recursive:false,mode:0o700});const db=new DatabaseSync(join(src,'cargo.sqlite'));
await backup(db,join(dest,'cargo.sqlite'));db.close();await cp(join(src,'labels'),join(dest,'labels'),{recursive:true});
await writeFile(join(dest,'backup.json'),JSON.stringify({created:new Date().toISOString(),note:'建议停止服务后备份，使数据库和面单完全一致'}));console.log('备份完成：'+dest);
