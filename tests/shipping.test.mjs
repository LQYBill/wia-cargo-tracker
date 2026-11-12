import test from 'node:test';import assert from 'node:assert/strict';
import{shippingFields,publicShipment,fileType}from'../lib/shipping.mjs';
test('总价只手填，重量单价和其他费用不会自动改变总价',()=>{
 const s=shippingFields({transport_mode:'海运',freight_company:'公司',confirmed_weight:'10',unit_price:'20',currency:'EUR',other_fees:'35.12',other_fees_note:'偏远附加费'});assert.equal(s.total_price,null);assert.equal(s.confirmed_weight,'10.000');assert.equal(s.other_fees,'35.12');assert.equal(s.payment_status,'unpaid');
 const confirmed=shippingFields({total_price:'249.99'},s);assert.equal(confirmed.total_price,'249.99');assert.equal(shippingFields({unit_price:'100',other_fees:'60'},confirmed).total_price,'249.99');
 assert.equal(shippingFields({total_price:''},confirmed).total_price,null);assert.equal(shippingFields({payment_status:'paid'},confirmed).total_price,'249.99');
});
test('无效方式、币种、重量和精度被拒绝',()=>{
 for(const data of [{transport_mode:'未知选项'},{currency:'INVALID'},{confirmed_weight:'0'},{confirmed_weight:'-1'},{confirmed_weight:'1.1234'},{unit_price:'1e3'},{total_price:'NaN'},{total_price:'1.001'},{other_fees:'-1'},{other_fees_note:'x'.repeat(1001)},{payment_status:'pending'}])assert.throws(()=>shippingFields(data));
 assert.equal(shippingFields({}).confirmed_weight,null);assert.equal(shippingFields({}).total_price,null);
});
test('销售采用字段白名单，不允许内部费用进入响应',()=>{
 const s=publicShipment({id:'id',transport_mode:'卡航',freight_company:'秘密公司',confirmed_weight:'10',unit_price:'20',total_price:'200',currency:'CNY',other_fees:'10',other_fees_note:'秘密附加费',payment_status:'paid',paid_at:'date',paid_by:'actor',future_private_field:'secret',documents:[]});assert.deepEqual(s,{id:'id',transport_mode:'卡航',documents:[]});
});
test('附件扩展名与内容头需匹配',()=>{
 assert.equal(fileType('invoice.pdf',Buffer.from('%PDF-1.4')),'application/pdf');assert.match(fileType('products.xlsx',Buffer.from([80,75,3,4,0])),/spreadsheetml/);
 assert.throws(()=>fileType('products.xlsx',Buffer.from('<html>')));assert.throws(()=>fileType('invoice.html',Buffer.from('<html>')));
});
