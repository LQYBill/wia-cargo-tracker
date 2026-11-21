import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),root=dirname(fileURLToPath(import.meta.url));
export function extractTracking(text){
 const upper=String(text||'').toUpperCase(),found=new Map();
 const add=(number,carrier)=>{const n=number.replace(/\s+/g,'');found.set(carrier+':'+n,{number:n,carrier});};
 for(const line of upper.split(/[\r\n]+/)){
  if(/\bDPD\b/.test(upper)){
   const match=line.match(/^\s*(\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{2})(?:\s+[A-Z])?\s*$/);
   if(match)add(match[1].replace(/[ -]/g,''),'DPD');
  }
  const corrected=/UPS|TRACKING/.test(upper)?line.replace(/\b[IL]\s*Z(?=\s*[A-Z0-9])/g,'1Z'):line;
  for(const match of corrected.matchAll(/\b1\s*Z(?:\s*[A-Z0-9]){16}(?![A-Z0-9])/g))add(match[0],'UPS');
  if(/FEDEX|FEDERAL EXPRESS/.test(upper)&&/TRACKING|TRK\s*#|TRACK\s*ID/.test(line)){
   const tail=line.replace(/^.*?(?:TRACKING(?:\s*(?:ID|NO|NUMBER))?|TRK\s*#|TRACK\s*ID)\s*[:#.]?\s*/,'');
   const match=tail.match(/^((?:\d[ -]?){12,22})(?!\d)/);if(match){const n=match[1].replace(/[ -]/g,'');if([12,15,20,22].includes(n.length))add(n,'FedEx');}
  }
  if(/DHL/.test(upper)&&/WAYBILL|TRACKING/.test(line)){
   const match=line.match(/(?:WAYBILL|TRACKING(?:\s*(?:NUMBER|NO))?)\s*[:#.]?\s*((?:\d[ -]?){10})(?!\d)/);if(match)add(match[1].replace(/[ -]/g,''),'DHL');
  }
 }
 return [...found.values()];
}
export async function readLabel(file){
 let text='',available=false,engine='';
 if(process.platform==='win32'){
  try{
   const script=await readFile(join(root,'../scripts/windows-ocr.ps1'),'utf8');
   const command='& {\n'+script+'\n} -ImagePath \''+resolve(file).replace(/'/g,"''")+'\'';
   const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{timeout:90000,maxBuffer:2*1024*1024,windowsHide:true,encoding:'utf8'});
   text=JSON.parse(stdout.replace(/^\uFEFF/,'')).text||'';available=true;engine='Windows OCR';
  }catch{}
 }
 if(!available){
  const dir=await mkdtemp(join(tmpdir(),'cargo-ocr-'));
  try{
   const tesseract=process.env.TESSERACT_BIN||'tesseract';
   await exec(tesseract,['--version'],{timeout:5000,maxBuffer:1024*1024,windowsHide:true});
   for(const angle of [0,180,90,270]){
    let input=file;
    if(angle){if(process.platform==='win32'&&!process.env.IMAGEMAGICK_BIN)continue;input=join(dir,'rotate-'+angle+'.png');try{await exec(process.env.IMAGEMAGICK_BIN||'convert',[file,'-rotate',String(angle),input],{timeout:10000,maxBuffer:1024*1024,windowsHide:true});}catch{continue;}}
    try{const r=await exec(tesseract,[input,'stdout','--psm','11'],{timeout:20000,maxBuffer:1024*1024,windowsHide:true});text+='\n'+r.stdout;available=true;engine='Tesseract';}catch{}
   }
  }catch{}finally{await rm(dir,{recursive:true,force:true});}
 }
 const candidates=extractTracking(text);
 return {available,engine,candidates,numbers:candidates.map(c=>c.number),message:!available?'面单识别服务不可用，请联系管理员配置 OCR':candidates.length===1?'已自动识别并填入单号':candidates.length>1?'识别到多个单号，请选择对应包裹':'未能可靠识别单号，请上传更清晰的面单或手动填写'};
}
