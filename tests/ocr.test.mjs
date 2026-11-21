import test from'node:test';import assert from'node:assert/strict';import{extractTracking}from'../lib/ocr.mjs';
test('UPS带空格的单号与OCR前缀I/1纠错，重复方向去重',()=>{
 const result=extractTracking('UPS STANDARD\nTRACKING#: IZ 14V4W1 680044 6871\nTRACKING#: 1Z 14V 4W1 68 0044 6871');assert.deepEqual(result,[{number:'1Z14V4W16800446871',carrier:'UPS'}]);
});
test('照片中的参考号和不完整单号不能当运单号',()=>{
 assert.deepEqual(extractTracking('UPS STANDARD\nRef No 2610210883U008\nTRACKING#: 1Z W37 16B 68 01'),[]);
 assert.deepEqual(extractTracking('REFERENCE 123456789012\nPHONE 33761412078'),[]);
});
test('多个单号保留候选，不自动选定第一票',()=>{assert.equal(extractTracking('UPS\n1Z14V4W16800446871\n1ZW3716B6801448354').length,2);});
test('FedEx与DHL需品牌和单号标签，不从无关数字猜测',()=>{
 assert.deepEqual(extractTracking('FedEx\nTRACKING ID: 1234 5678 9012'),[{number:'123456789012',carrier:'FedEx'}]);
 assert.deepEqual(extractTracking('DHL EXPRESS\nWAYBILL: 1234 5678 90'),[{number:'1234567890',carrier:'DHL'}]);
});
test('DPD面单识别带空格的14位单号，不截取长条码',()=>{
 assert.deepEqual(extractTracking('dpd\n0141 5091 1023 49 A'),[{number:'01415091102349',carrier:'DPD'}]);
 assert.deepEqual(extractTracking('dpd\n0093 600 0141 5091 1023 49 101 902 9'),[]);
});
