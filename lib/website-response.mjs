// Keep only diagnostic headers; never persist cookies or authorization headers.
export function websiteResponseInfo(response){
 const headers=response.headers();
 return{status:response.status(),type:headers['content-type']||'',server:headers.server||'',challenge:headers['cf-mitigated']||'',ray:headers['cf-ray']||''};
}
export function websiteAccessError(info={},title=''){
 if(info.challenge==='challenge')return `官网安全验证拦截（Cloudflare，HTTP ${info.status}），未取得物流轨迹；请使用官方API或人工核验`;
 if(/Access Denied/i.test(title)||/application\/blank/i.test(info.type))return `官网拒绝访问（${/akamai/i.test(info.server)?'Akamai，':''}HTTP ${info.status??'未知'}${info.type?'，'+info.type:''}），返回的不是物流网页；请使用官方API或人工核验`;
 if(info.status===429)return '官网请求限流（HTTP 429），未取得物流轨迹，请稍后重试';
 if(info.status>=400)return '官网返回HTTP '+info.status+'，未取得物流页面';
 return null;
}
