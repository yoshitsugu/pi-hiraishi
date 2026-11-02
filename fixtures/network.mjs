import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { runtimePolicy, validateConfig } from '../policy.ts';

const root=process.argv[2];
const cert=readFileSync(`${root}/server.crt`),key=readFileSync(`${root}/server.key`);
const seen=[];
const handler=(req,res)=>{seen.push(req.method);res.end(`accepted ${req.method}`)};
const plain=http.createServer(handler), secure=https.createServer({key,cert},handler);
plain.listen(0);secure.listen(0);await Promise.all([once(plain,'listening'),once(secure,'listening')]);
const plainPort=plain.address().port,securePort=secure.address().port;
for(const d of ['project','session','session/home','session/temp'])mkdirSync(`${root}/${d}`);
const input={cwd:`${root}/project`,configPath:`${root}/config`,runtimeRoot:'/opt/hiraishi',srtRoot:'/usr',temp:`${root}/session/temp`,home:`${root}/session/home`,config:validateConfig({socatPath:process.env.HIRAISHI_TEST_SOCAT})};
function proxyRequest(method,agent) {
  return new Promise((resolve,reject)=>{
    const r=http.request({host:'localhost',port:securePort,path:'/',method,agent},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,body,reused:r.reusedSocket}));});
r.setTimeout(4000,()=>r.destroy(Error('request timeout '+method)));r.on('error',reject);r.end();
  });
}
async function tlsAgent() {
  const socket=await new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port:SandboxManager.getProxyPort(),method:'CONNECT',path:`localhost:${securePort}`,headers:{'Proxy-Authorization':`Basic ${Buffer.from(`srt:${SandboxManager.getProxyAuthToken()}`).toString('base64')}`}});
    r.on('connect',(res,socket)=>{if(res.statusCode!==200){socket.destroy();reject(Error(`CONNECT ${res.statusCode}`));}else resolve(socket);});r.on('error',reject);r.end();
  });
  const wrapped=tls.connect({socket,servername:'localhost',ca:SandboxManager.getMitmCA().certPem});
  await once(wrapped,'secureConnect');
  const agent=new http.Agent({keepAlive:true,maxSockets:1});agent.createConnection=()=>wrapped;
  return agent;
}
try {
  for(const mode of ['http-get','http-all']) {
    const policy=runtimePolicy({...input,mode});
    // Only this fixture admits localhost so no external service or public DNS is needed.
    policy.network.allowedDomains=[`localhost:${plainPort}`,`localhost:${securePort}`];
    await SandboxManager.initialize(policy,undefined,false);
    const agent=await tlsAgent();
    try {
      assert.equal((await proxyRequest('GET',agent)).status,200);

      const before=seen.length;
      const post=await proxyRequest('POST',agent);
      assert.equal(post.status,mode==='http-get'?403:200);assert.equal(post.reused,true);
      if(mode==='http-get') {
        assert.match(post.body,/network mode http-get/);
        assert.match(post.body,/pause the affected work/);
        assert.match(post.body,/continue offline/);
        assert.match(post.body,/http-all/);
      }
      for(const method of ['PUT','DELETE']) {
        const next=await tlsAgent();
        try {assert.equal((await proxyRequest(method,next)).status,mode==='http-get'?403:200);}finally{next.destroy();}
      }
      assert.equal(seen.length-before,mode==='http-get'?0:3);
      const result=await new Promise((resolve,reject)=>{
        const r=http.request({host:'127.0.0.1',port:SandboxManager.getProxyPort(),path:`http://localhost:${plainPort}/`,method:'POST',headers:{Host:`localhost:${plainPort}`,'Proxy-Authorization':`Basic ${Buffer.from(`srt:${SandboxManager.getProxyAuthToken()}`).toString('base64')}`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});r.on('error',reject);r.end();
      });
      assert.equal(result,mode==='http-get'?403:200);
    } finally {agent.destroy();await SandboxManager.reset();}
  }
  console.log('local HTTP/HTTPS method and keep-alive checks passed');
} finally {await SandboxManager.reset();plain.closeAllConnections();secure.closeAllConnections();plain.close();secure.close();}
