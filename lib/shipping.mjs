export const transportModes=['海运','卡航','空运','铁路'];
const currencies=['CNY','EUR','USD','GBP'];
function decimal(value,scale,label){
 if(value===null||value===undefined||value==='')return null;
 const text=String(value).trim();
 if(!new RegExp('^\\d{1,12}(\\.\\d{1,'+scale+'})?$').test(text))throw Error(label+'需为非负数字，小数最多'+scale+'位');
 const [whole,fraction='']=text.split('.');return BigInt(whole).toString()+'.'+fraction.padEnd(scale,'0');
}
export function shippingFields(input,current={}){
 const get=k=>Object.hasOwn(input,k)?input[k]:current[k];
 const rawMode=String(get('transport_mode')||'');
 const transport_mode=rawMode==='地铁'?'铁路':rawMode;
 if(transport_mode&&!transportModes.includes(transport_mode))throw Error('运输方式请选择海运、卡航、空运或铁路');
 const freight_company=String(get('freight_company')||'').trim();if(freight_company.length>200)throw Error('物流公司最多200字');
 const transfer_number=String(get('transfer_number')||'').trim().toUpperCase();
 if(transfer_number&&!/^[A-Z0-9_.-]{1,80}$/.test(transfer_number))throw Error('物流内部单号可包含字母、数字、连字符、下划线和点号，最多80位');
 const confirmed_weight=decimal(get('confirmed_weight'),3,'确认重量'),unit_price=decimal(get('unit_price'),4,'单价');
 if(confirmed_weight!==null&&BigInt(confirmed_weight.replace('.',''))===0n)throw Error('确认重量需大于0');
 const currency=String(get('currency')||'CNY');if(!currencies.includes(currency))throw Error('币种无效');
 const total_price=decimal(get('total_price'),2,'总价');
 if(total_price&&total_price.split('.')[0].length>12)throw Error('总价超出允许范围');
 const other_fees=decimal(get('other_fees'),2,'其他费用'),other_fees_note=String(get('other_fees_note')||'').trim();
 if(other_fees_note.length>1000)throw Error('其他费用说明最多1000字');
 const payment_status=String(get('payment_status')||'unpaid');if(!['unpaid','paid'].includes(payment_status))throw Error('付款状态只能为未付或已付');
 return {transport_mode,freight_company,transfer_number,confirmed_weight,unit_price,total_price,currency,other_fees,other_fees_note,payment_status};
}
export function fileType(name,bytes){
 const ext=String(name).toLowerCase().split('.').at(-1);
 if(ext==='pdf'&&bytes.subarray(0,5).toString()==='%PDF-')return'application/pdf';
 if(ext==='png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';
 if(['jpg','jpeg'].includes(ext)&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return'image/jpeg';
 if(ext==='xlsx'&&bytes.subarray(0,4).equals(Buffer.from([80,75,3,4])))return'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
 if(ext==='xls'&&bytes.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225])))return'application/vnd.ms-excel';
 throw Error('文件格式或内容不符：发票支持 PDF/JPG/PNG/XLS/XLSX，产品表支持 XLS/XLSX');
}
export function publicShipment(s){
 // Explicit allowlist: confidential commercial fields and invoice metadata never reach sales clients.
 const keys=['inbound_customer','id','product','number','carrier','batch','destination','notes','attachment','created','last_sync','enabled','sales_id','transport_mode','events','metrics','sales_name','sales_username','documents','package_group','t6_tracking'];
 return Object.fromEntries(keys.filter(k=>Object.hasOwn(s,k)).map(k=>[k,s[k]]));
}
