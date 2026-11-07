import { spawn } from 'node:child_process';
import fs from 'node:fs';
const chrome = spawn('chromium', [
  '--headless=new','--no-sandbox','--disable-gpu','--window-size=900,900',
  '--remote-debugging-port=9228','http://127.0.0.1:8787/'
], {stdio:['ignore','ignore','ignore']});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let target=null;
for (let i=0;i<60;i++) {
  try { const r=await fetch('http://127.0.0.1:9228/json/list'); const l=await r.json();
    target=l.find(t=>t.type==='page' && t.url.includes('127.0.0.1:8787')); if(target) break; } catch(e){}
  await sleep(300);
}
if(!target) throw new Error('sem target');
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
let id=0; const pending=new Map();
ws.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){const {res,rej}=pending.get(m.id);pending.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};
function send(method,params={}){const mid=++id;return new Promise((res,rej)=>{pending.set(mid,{res,rej});ws.send(JSON.stringify({id:mid,method,params}));});}
await send('Runtime.enable'); await send('Page.enable');
const xpub='xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';
await send('Runtime.evaluate',{expression:`document.getElementById('xpub').value=${JSON.stringify(xpub)}; document.getElementById('wallet-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`});
let out={};
for (let i=0;i<120;i++) {
  const r=await send('Runtime.evaluate',{expression:`JSON.stringify({hidden:document.getElementById('out').hidden,total:document.getElementById('v-total').textContent,updated:document.getElementById('v-updated').textContent,types:[...document.querySelectorAll('#types-table tbody tr')].map(tr=>tr.textContent.replace(/\\s+/g,' ').trim()),receive:[...document.querySelectorAll('#receive-table tbody tr')].map(tr=>tr.textContent.replace(/\\s+/g,' ').trim()),rows:document.querySelectorAll('#addresses-table tbody tr').length,warnings:document.getElementById('v-warnings').textContent,status:document.getElementById('status').textContent})`,returnByValue:true});
  out=JSON.parse(r.result.value); if(!out.hidden) break; await sleep(500);
}
console.log(JSON.stringify(out,null,1));
const shot=await send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync('/tmp/cloud-ui.png',Buffer.from(shot.data,'base64'));
ws.close(); chrome.kill('SIGKILL');
