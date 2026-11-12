import {validTime} from './model.mjs';
export function websiteKind(text){
 const d=String(text).toLowerCase();
 if(/delivery (failure|failed)|exception|return to sender/.test(d))return'exception';
 if(/label created|has not received|shipment ready|information (received|sent)/.test(d))return'label';
 if(/out for delivery/.test(d))return'out';
 if(/\bdelivered\b/.test(d))return'delivered';
 if(/we have your (parcel|package)|\bpicked up\b|pickup scan/.test(d))return'pickup';
 if(/(customs|clearance).*(completed|released|cleared)/.test(d)&&!/not |pending|hold|delay/.test(d))return'cleared';
 if(/customs|clearance/.test(d))return'customs';
 if(/arrived|departed|on the way|in transit|processing at/.test(d))return'transit';
 return'unknown';
}
const locations=[[/poland|warsaw|warszawa/i,'Europe/Warsaw'],[/france|\bparis\b|cachan|massy|charenton|corbeil/i,'Europe/Paris'],[/germany|nurnberg|nürnberg|koeln|köln/i,'Europe/Berlin'],[/belgium|brussels|bruxelles/i,'Europe/Brussels'],[/netherlands|amsterdam|eindhoven/i,'Europe/Amsterdam'],[/united kingdom|\blondon\b/i,'Europe/London'],[/china|shenzhen|guangzhou|shanghai/i,'Asia/Shanghai'],[/hong kong/i,'Asia/Hong_Kong']];
export function localEventTime(date,time,location){
 const zone=locations.find(([regex])=>regex.test(location))?.[1];if(!zone)throw Error('无法确认事件地点的时区，需人工核验：'+String(location).slice(0,100));
 const target=Date.parse(date+'T'+time+':00Z');if(!validTime(date+'T'+time+':00Z'))throw Error('网页事件日期无效');
 const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 let utc=target;
 for(let i=0;i<3;i++){const p=Object.fromEntries(formatter.formatToParts(new Date(utc)).map(x=>[x.type,x.value]));const actual=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);utc+=target-actual;}
 const iso=new Date(utc).toISOString();if(!validTime(iso))throw Error('网页事件日期无效');return iso;
}
export function parseUpsPage({number,body,history}){
 if(body.match(/\b1Z[A-Z0-9]{16}\b/i)?.[0]!==number)throw Error('UPS页面单号与待查询单号不一致');
 const matches=[...history.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}:\d{2})\b/g)],events=[];
 for(let i=0;i<matches.length;i++){
  const m=matches[i],description=history.slice(m.index+m[0].length,matches[i+1]?.index??history.length).trim().replace(/\n\s*\n/g,'\n');
  const kind=websiteKind(description);if(kind==='unknown')continue;
  const location=description.split('\n').filter(Boolean).at(-1)||'';
  events.push({time:localEventTime(`${m[3]}-${m[2]}-${m[1]}`,m[4].padStart(5,'0'),location),kind,description,location,source:'UPS 官网自动查询'});
 }
 if(!events.length)throw Error('UPS未返回可验证时间的物流事件，可能需要验证码或页面结构已变化');
 return events;
}
export function parse17Page({number,body}){
 if(!body.includes(number))throw Error('17TRACK页面单号不匹配');
 const text=body.includes('Tracking Information')?body.slice(body.indexOf('Tracking Information')):body;
 const matches=[...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::\d{2})?\b/g)],events=[];
 for(let i=0;i<matches.length;i++){
  const m=matches[i],description=text.slice(m.index+m[0].length,matches[i+1]?.index??text.length).trim();
  if(/^\(GMT/.test(description))continue;
  const kind=websiteKind(description);if(kind==='unknown')continue;
  const firstLine=description.split('\n').filter(Boolean)[0]||description;
  const location=firstLine.split(',')[0].trim();
  events.push({time:localEventTime(m[1],m[2],firstLine),kind,description:firstLine,location,source:'17TRACK 网页自动查询'});
 }
 if(!events.length)throw Error('17TRACK未返回可验证时间的轨迹，可能被限流或需要验证码');
 return events;
}
