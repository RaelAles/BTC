import worker from '../src/worker.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import { startFakeElectrum, nodeConnect, deadPort } from './fake-electrum.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bci = JSON.parse(fs.readFileSync(new URL('./fixtures/bci.json', import.meta.url),'utf8'));
const USER='xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';
const OLD='xpub6C58iKx54JK7v9cZqtmZiz5FBqYu4fPCsjHTssDYbJmnQe6mjT8RJQpbdntyyXHsui2sTqKMyCiVkPCvfu8R9eNLLqPV1FSadU2kGzjSqUH';
const ua=parseXpub(USER);
const addr = {};
for (const t of ['bip86','bip84','bip49']) addr[t]=(await deriveAddress(t,ua,0,0)).address;

const stats0 = {chain_stats:{funded_txo_count:0,funded_txo_sum:0,spent_txo_count:0,spent_txo_sum:0,tx_count:0},mempool_stats:{funded_txo_count:0,funded_txo_sum:0,spent_txo_count:0,spent_txo_sum:0,tx_count:0}};
function stats(bal, tx=1){return {chain_stats:{funded_txo_count:tx,funded_txo_sum:bal,spent_txo_count:0,spent_txo_sum:0,tx_count:tx},mempool_stats:{funded_txo_count:0,funded_txo_sum:0,spent_txo_count:0,spent_txo_sum:0,tx_count:0}};}
let calls=[];
globalThis.fetch = async function(url, opts){
  url=String(url); calls.push(url);
  if (url.includes('blockchain.info/xpub/')) {
    const x=decodeURIComponent(url.split('/xpub/')[1].split('?')[0]);
    const body = x===USER ? bci : {n_tx:0,final_balance:0,total_received:0,txs:[]};
    return new Response(JSON.stringify(body), {status:200,headers:{'Content-Type':'application/json'}});
  }
  if (url.includes('/address/')) {
    const a=decodeURIComponent(url.split('/address/')[1]);
    let s=stats0;
    if (a===addr.bip86) s=stats(11100);
    else if (a===addr.bip84) s=stats(1000);
    return new Response(JSON.stringify(s), {status:200,headers:{'Content-Type':'application/json'}});
  }
  throw new Error('url inesperada '+url);
};

class Stmt {
  constructor(db, sql, args=[]){this.db=db;this.sql=sql;this.args=args;}
  bind(...args){this.args=args;return this;}
  async run(){return this.db.run(this.sql,this.args);}
  async first(){return this.db.first(this.sql,this.args);}
  async all(){return {results:this.db.all(this.sql,this.args)};}
}
class DB {
  constructor(){this.wallets=[];this.addresses=[];}
  prepare(sql){return new Stmt(this,sql);}
  async batch(stmts){for (const s of stmts) await s.run();}
  run(sql,args){
    if (sql.startsWith('INSERT INTO wallets')) {
      const [hash,xpub,version,type,created,updated]=args;
      this.wallets.push({xpub_hash:hash,xpub,version_type:version,account_type:type,next_receive:0,next_change:0,balance:0,created_at:created,updated_at:updated});
    } else if (sql.startsWith('UPDATE wallets')) {
      const [type,nr,nc,bal,updated,hash]=args;
      const w=this.wallets.find(x=>x.xpub_hash===hash); if(w){Object.assign(w,{account_type:type,next_receive:nr,next_change:nc,balance:bal,updated_at:updated});}
    } else if (sql.startsWith('INSERT INTO addresses')) {
      const [hash,type,chain,idx,address,used,balance,received,tx,updated]=args;
      const old=this.addresses.find(a=>a.xpub_hash===hash&&a.account_type===type&&a.chain===chain&&a.idx===idx);
      const row={xpub_hash:hash,account_type:type,chain,idx,address,used,balance,received,tx_count:tx,updated_at:updated};
      if(old) Object.assign(old,row); else this.addresses.push(row);
    }
  }
  first(sql,args){
    if (sql.startsWith('SELECT * FROM wallets')) return this.wallets.find(w=>w.xpub_hash===args[0]) || null;
    return null;
  }
  all(sql,args){
    if (sql.startsWith('SELECT * FROM addresses')) {
      return this.addresses.filter(a=>a.xpub_hash===args[0]).sort((a,b)=>a.account_type.localeCompare(b.account_type)||a.chain-b.chain||a.idx-b.idx);
    }
    return [];
  }
}

function req(xpub){return new Request('https://x/api/wallet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({xpub})});}
async function run(xpub,db,env){
  const r=await worker.fetch(req(xpub),Object.assign({DB:db},env||{}));
  const j=await r.json();
  return {status:r.status,j};
}
const db=new DB();
calls=[];
const r1=await run(USER,db);
console.log('user status',r1.status,'type',r1.j.detected_type,'receive',r1.j.receive&&r1.j.receive.address,r1.j.receive&&r1.j.receive.path);
console.log('balance',r1.j.balance,'addresses',r1.j.addresses.length,'extras',r1.j.extras.map(e=>[e.type,e.balance]));
console.log('calls',calls.length);
const r2=await run(USER,db);
console.log('user2',r2.j.receive&&r2.j.receive.path,r2.j.balance,'addresses',db.addresses.length);
const db2=new DB(); calls=[];
const o=await run(OLD,db2);
console.log('old',o.status,o.j.detected_type,o.j.receive&&o.j.receive.address,o.j.receive&&o.j.receive.path,'bal',o.j.balance,'calls',calls.length);
const zb='zpub6qjfKfHuMfQ5cjzoWcLp9AGFXmqnwuNChxKuSf1KMKXYWqjEEmTYYY8sgCp9yLbiizGUxnWUtXRbWxS47HxSk7jY5WnLB55ZAvA345XxvUh';
const db3=new DB(); calls=[];
const z=await run(zb,db3);
console.log('zpub',z.status,z.j.detected_type,z.j.receive&&z.j.receive.address,z.j.receive&&z.j.receive.path,'calls',calls.length);

/* ---- Cenário com Electrum: união completa dos quatro tipos ---- */
setConnectOverride(nodeConnect);
const shOf = async (type, chain, idx) => scripthash((await deriveAddress(type, ua, chain, idx)).script);
const balances = {};
balances[await shOf('bip84', 0, 3)] = 5000;
balances[await shOf('bip84', 1, 1)] = 2000;
balances[await shOf('bip86', 0, 7)] = 1234;
const fake = await startFakeElectrum({ balances });
const dbe = new DB(); calls = [];
const t0 = Date.now();
const e = await run(USER, dbe, {
  ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp',
  ELECTRUM_TIMEOUT_MS: '5000'
});
console.log('electrum', e.status, e.j.source, JSON.stringify(e.j.balance), e.j.extras.map(x => [x.type, x.balance]), 'pedidos', fake.requests.length, (Date.now() - t0) + 'ms');
assert.equal(e.status, 200);
assert.equal(e.j.detected_type, 'bip44');
assert.match(e.j.source, /electrum/);
assert.ok(!/Esplora/.test(e.j.source), 'com Electrum vivo o Esplora não é chamado');
const extraBal = Object.fromEntries(e.j.extras.map(x => [x.type, x.balance]));
assert.equal(extraBal.bip84, 7000, 'bip84 /0/3 + /1/1 vindos do Electrum');
assert.equal(extraBal.bip86, 1234, 'bip86 /0/7 vem do Electrum');
assert.equal(extraBal.bip49, undefined, 'tipo sem uso não entra nos extras');
assert.equal(e.j.balance.extras, 8234);
assert.equal(e.j.balance.detected, 12835640, 'bip44 continua no blockchain.info');
const row84 = e.j.addresses.find(a => a.account_type === 'bip84' && a.chain === 0 && a.idx === 3);
assert.ok(row84 && row84.balance === 5000 && row84.used === 1, 'endereço usado do bip84 gravado no D1');
const rowChg = e.j.addresses.find(a => a.account_type === 'bip84' && a.chain === 1 && a.idx === 1);
assert.ok(rowChg && rowChg.balance === 2000, 'ramo de troco também foi varrido');
assert.ok(fake.requests.length > 100, 'consulta em lote, não um fetch por endereço');
await fake.close();

/* ---- Fallback: Electrum fora do ar, tudo volta ao Esplora ---- */
const db4 = new DB(); calls = [];
const f = await run(USER, db4, {
  ELECTRUM_SERVERS: '127.0.0.1:' + (await deadPort()) + ':tcp',
  ELECTRUM_TIMEOUT_MS: '1000'
});
console.log('fallback', f.status, f.j.source, JSON.stringify(f.j.balance));
assert.equal(f.status, 200);
assert.match(f.j.source, /Esplora/);
assert.ok(f.j.warnings.some(w => /Electrum indisponível/.test(w)), 'aviso de Electrum fora do ar');
assert.equal(f.j.balance.detected, 12835640);
console.log('electrum/fallback ok');
