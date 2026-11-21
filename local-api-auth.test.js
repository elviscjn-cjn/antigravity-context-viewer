const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolveHostAuthToken}=require('./local-api');
const auth={getActiveLsBaseUrl:()=> 'https://127.0.0.1:58017',getActiveLsCsrfToken:()=> 'test-only-token'};
test('2.34 main-process token matches exact active service',()=>{assert.equal(resolveHostAuthToken('https://127.0.0.1:58017',auth),'test-only-token');});
test('reject different ports and nonlocal origins',()=>{for(const origin of ['https://127.0.0.1:1','https://example.com:58017'])assert.equal(resolveHostAuthToken(origin,auth),null);});
test('reject missing or empty host auth',()=>{assert.equal(resolveHostAuthToken('https://127.0.0.1:58017',{}),null);assert.equal(resolveHostAuthToken('https://127.0.0.1:58017',{...auth,getActiveLsCsrfToken:()=>''}),null);});
test('empty page token falls back to matching main-process auth and authenticates RPC',async()=>{
 const http=require('node:http'),Module=require('node:module');
 const server=http.createServer((req,res)=>{if(req.method==='GET')return res.end('window.__APP_CONFIG__ = {"csrfToken":""};');if(req.headers['x-codeium-csrf-token']!=='fixture-token'){res.statusCode=403;return res.end('Forbidden');}res.end('{"ok":true}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;const load=Module._load;
 Module._load=function(id,...args){if(id==='./authBootstrap')return {getActiveLsBaseUrl:()=>origin,getActiveLsCsrfToken:()=> 'fixture-token'};return load.call(this,id,...args);};
 try{const api=await require('./local-api').connect({origin});assert.deepEqual(await api.call('GetUserStatus',{}),{ok:true});}finally{Module._load=load;await new Promise(r=>server.close(r));}
});
