export const labels = {unknown:'暂无轨迹',label:'已建单 · 待提取',pickup:'已提取',transit:'运输中',customs:'清关处理中',cleared:'已清关',out:'派送中',delivered:'已签收',partial:'部分箱已签收',exception:'物流异常'};
export function validTime(s) {
 if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))return false;
 const [y,m,d]=s.slice(0,10).split('-').map(Number),date=new Date(Date.UTC(y,m-1,d));
 return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d;
}
export function normalizeNumber(s) { return String(s||'').replace(/\s+/g,'').toUpperCase(); }
export function classify(e) {
  const stage=e.stage||'', sub=e.sub_status||'', d=String(e.description||'').toLowerCase();
  // Negation and pending clearance must never become completed milestones.
  if (/exception|fail|return|expired/i.test(stage+' '+sub)) return 'exception';
  if (stage==='Delivered') return 'delivered';
  if (stage==='OutForDelivery') return 'out';
  if (stage==='PickedUp') return 'pickup';
  if (/clearance.*(complete|completed)|customs.*(released|cleared)|released.*customs/.test(d) && !/not |await|pending|delay|hold/.test(d)) return 'cleared';
  if (/customs|clearance/.test(d)) return 'customs';
  if (stage==='InfoReceived' || /label created|not received|information sent/.test(d)) return 'label';
  if (/^(picked up|we have your (parcel|package)|pickup scan)$/i.test(d.trim())) return 'pickup';
  if (stage==='InTransit' || stage==='Departure' || stage==='Arrival') return 'transit';
  return 'unknown';
}
export function metrics(events, now=Date.now()) {
  const list=events.filter(e=>validTime(e.time)).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  const first=k=>{
    const matches=list.filter(e=>e.kind===k);
    if(k==='label'){
      const official=matches.filter(e=>/^(UPS|FedEx|DHL) 官网自动查询$/.test(e.source||''));
      if(official.length)return official.sort((a,b)=>Date.parse(b.created||'1970-01-01')-Date.parse(a.created||'1970-01-01'))[0].time;
    }
    return matches[0]?.time||null;
  };
  const label=first('label'), pickup=first('pickup'), cleared=first('cleared'), out=first('out'), delivered=first('delivered');
  const days=(a,b)=>a&&b&&Date.parse(b)>=Date.parse(a)?+( (Date.parse(b)-Date.parse(a))/86400000).toFixed(2):null;
  const latest=list.filter(e=>e.kind!=='unknown').at(-1);
  return {status:latest?.kind||'unknown',label,pickup,cleared,out,delivered,waitDays:days(label,pickup||(!delivered?new Date(now).toISOString():null)),waitOpen:!!label&&!pickup&&!delivered,transitDays:days(pickup,delivered),clearanceDays:days(pickup,cleared),totalDays:days(label,delivered),deliveryDays:days(out,delivered),staleDays:list.length?days(list.at(-1).time,new Date(now).toISOString()):null};
}
export function parse17(item, carrier='') {
  const info=item?.track_info;
  if (!info || typeof info!=='object') throw Error('17TRACK 尚无可用轨迹');
  const result=[];
  for (const p of info.tracking?.providers||[]) {
    // Only use chosen last-mile provider for milestone timing; do not treat first-mile pickup as UPS possession.
    const name=String(p.provider?.name||'');
    const same=!carrier||carrier==='其他'||name.toLowerCase().includes(carrier.toLowerCase());
    for(const e of p.events||[]) {
      const time=e.time_iso||e.time_utc;
      if(!validTime(time)) continue;
      let kind=classify(e);
      if(!same && ['label','pickup','delivered','out'].includes(kind)) kind='unknown';
      result.push({time,kind,description:String(e.description||e.stage||'未描述事件'),location:String(e.location||''),source:'17TRACK / '+name});
    }
  }
  return result;
}
