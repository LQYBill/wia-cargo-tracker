import test from'node:test';import assert from'node:assert/strict';import{parseUpsPage,parse17Page,localEventTime,websiteKind}from'../lib/website-parser.mjs';
import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';import{openStore}from'../lib/store.mjs';import{createWebsiteProvider}from'../lib/website.mjs';
const number='1ZW3716B6812954456';

test('17TRACK仅写新增扫描，已人工核验的同一节点不因来源不同重复写入',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cargo-dedup-')),store=openStore(dir);
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 const s=store.add({product:'test',number,carrier:'UPS'});
 store.ingest(s.id,[{time:'2026-10-29T16:17:00Z',kind:'label',description:'Old wording',source:'人工核验'}]);
 const body=number+'\nTracking Information\n2026-11-17 12:11 CACHAN, France, Delivered\n2026-10-29 17:17 Poland, Label Created';
 const ready={isVisible:async()=>true,waitFor:async()=>{},first(){return this;}};
 const page={on(){},goto:async url=>{assert.match(url,/t\.17track\.net/);return{status:()=>200};},getByText:()=>ready,getByRole:()=>ready,locator:()=>({innerText:async()=>body}),close:async()=>{}};
 const p=createWebsiteProvider(store,{launch:async()=>({newContext:async()=>({newPage:async()=>page}),close:async()=>{}})});
 assert.equal((await p.sync(s.id)).count,1);assert.equal((await p.sync(s.id)).count,0);assert.equal(store.get(s.id).events.length,2);
});
test('官网建单事件时间来自历史轨迹，不来自网页查询或系统日期',()=>{
 const ups=parseUpsPage({number,body:'Tracking Details\n'+number+'\n1 of 7 Piece Shipment',history:'Parcel History\n29/10/2026\n17:17\nLabel Created\nShipper created a label, UPS has not received the package yet.\nPoland'});assert.equal(ups[0].time,'2026-10-29T16:17:00.000Z');assert.equal(ups[0].kind,'label');
 const track=parse17Page({number,body:number+'\nTracking Information\nSync Time : 2026-11-10 19:52:18 (GMT+01:00)\n2026-10-29 17:17 Poland, Label Created, Shipper created a label, UPS has not received the package yet.'});assert.equal(track.length,1);assert.equal(track[0].time,ups[0].time);
});
test('未取得轨迹、单号不一致或时区不确定时拒绝猜日期',()=>{assert.throws(()=>parseUpsPage({number,body:'different',history:'29/10/2026 17:17 Label Created Poland'}));assert.throws(()=>parseUpsPage({number,body:number,history:'Shipped / Billed On 29/10/2026'}));assert.throws(()=>localEventTime('2026-10-29','17:17','Unknown location'));});
test('夏令时及否定状态不误判',()=>{assert.equal(localEventTime('2026-10-19','09:27','Poland'),'2026-10-19T07:27:00.000Z');assert.equal(websiteKind('Shipper created a label, UPS has not received the package yet.'),'label');assert.equal(websiteKind('Out for Delivery'),'out');});
test('浏览器就绪不等于官网连通，403必须显示失败且保留历史',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cargo-web-')),store=openStore(dir);
 try{const s=store.add({product:'test',number,carrier:'UPS'});store.ingest(s.id,[{time:'2026-10-29T16:17:00Z',kind:'label',description:'Label Created',source:'人工核验'}]);
 const page={on(){},goto:async()=>({status:()=>403}),title:async()=>'Just a moment...',locator:()=>({innerText:async()=>''}),close:async()=>{}};
 const p=createWebsiteProvider(store,{launch:async()=>({close:async()=>{},newContext:async()=>({newPage:async()=>page})})});await p.check();assert.equal(p.connection().ready,true);assert.equal(p.connection().siteState,'unverified');await assert.rejects(p.sync(s.id),/403/);assert.equal(p.connection().siteState,'blocked');assert.equal(store.get(s.id).last_sync,null);assert.equal(store.get(s.id).events.length,1);assert.match(store.get(s.id).error,/403/);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
