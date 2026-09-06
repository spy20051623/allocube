import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i=0;i<100;i++) { if (check()) return; await delay(50); } throw new Error("Timed out waiting for realtime update"); }
export async function startRealtimeFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "allocube-realtime-"));
  const socket = createServer(); await new Promise(resolve => socket.listen(0,"127.0.0.1",resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`, password = "RealtimeFixture82!";
  const ids = Object.fromEntries(["owner","peer","other","machine1","machine2","group1","group2"].map(key => [key,randomUUID()]));
  const env = { ...process.env, NODE_ENV:"production", DATABASE_PATH:path.join(directory,"data.sqlite"), HOST:"127.0.0.1", PORT:String(port), BOOTSTRAP_SITE_ORIGIN:origin, BOOTSTRAP_ADMIN_PASSWORD:password };
  const seed = `
    import { db, initializeDatabase } from './dist-server/server/db.js';
    import { randomUUID } from 'node:crypto';
    await initializeDatabase();
    const ids = ${JSON.stringify(ids)}, date = new Date().toISOString();
    const admin=db.prepare("SELECT id FROM users WHERE role='SYSTEM_ADMIN'").get().id;
    for(const name of ['owner','peer','other']) db.prepare("INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at) SELECT ?,?,?,?,password_hash,'USER','ACTIVE',?,? FROM users WHERE id=?").run(ids[name],name,name,name,date,date,admin);
    for(const n of [1,2]) {
      db.prepare('INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(ids['machine'+n],'Realtime machine '+n,date,date);
      db.prepare('INSERT INTO resource_groups(id,machine_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(ids['group'+n],ids['machine'+n],'CPU group '+n,date,date);
    }
    for(const [user,n] of [['owner',1],['owner',2],['peer',1],['other',2]]) db.prepare("INSERT INTO machine_access_memberships VALUES(?,?,?,'SEED',?,?,?)").run(randomUUID(),ids['machine'+n],ids[user],admin,date,date);
    db.close();
  `;
  const seeded=spawnSync(process.execPath,["--input-type=module","-e",seed],{env,encoding:"utf8",windowsHide:true});
  if(seeded.status!==0) throw new Error(seeded.stderr);
  let output="";
  const child=spawn(process.execPath,["dist-server/server/index.js"],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",chunk=>{output+=chunk;}); child.stderr.on("data",chunk=>{output+=chunk;});
  const close=async()=>{
    child.kill();
    const force=setTimeout(()=>child.kill("SIGKILL"),3000);
    if(child.exitCode===null) await new Promise(resolve=>child.once("exit",resolve));
    clearTimeout(force);
    assert(directory.startsWith(path.join(tmpdir(),"allocube-realtime-")));
    await rm(directory,{recursive:true,force:true});
  };
  try {
    for(let i=0;;i++) {
      if(child.exitCode!==null||i===60) throw new Error(output);
      try { if((await fetch(origin+"/health")).ok) break; } catch {}
      await delay(100);
    }
    const accounts={};
    for(const name of ["Administrator","owner","peer","other"]) {
      const response=await fetch(origin+"/api/v1/auth/login",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({identifierType:"USERNAME",identifier:name,password})});
      const body=await response.json(); assert.equal(response.status,200,JSON.stringify(body));
      accounts[name]={cookie:response.headers.get("set-cookie").split(";",1)[0],csrf:body.csrfToken};
    }
    const request=async(name,url,method="GET",body)=>{
      const response=await fetch(origin+"/api/v1"+url,{method,headers:{origin,cookie:accounts[name].cookie,"x-csrf-token":accounts[name].csrf,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json()};
    };
    return {origin,ids,accounts,password,request,close,logs:()=>output};
  } catch(error) { await close(); throw error; }
}

async function main() {
  const fixture=await startRealtimeFixture(), streams=[];
  try {
    for(const name of ["owner","peer","other","Administrator"]) {
      const controller=new AbortController(), events=[];
      const response=await fetch(fixture.origin+"/api/v1/events",{headers:{cookie:fixture.accounts[name].cookie},signal:controller.signal});
      assert.equal(response.status,200);
      const reader=response.body.getReader();
      const done=(async()=>{
        let pending="";
        try { while(true) {
          const {done,value}=await reader.read(); if(done) return;
          pending+=new TextDecoder().decode(value);
          let index;
          while((index=pending.indexOf("\n\n"))>=0) {
            const frame=pending.slice(0,index);pending=pending.slice(index+2);
            if(frame.startsWith("event: revision")) events.push(JSON.parse(frame.split("\ndata: ")[1]));
          }
        } } catch(error) { if(!controller.signal.aborted) throw error; }
      })();
      streams.push({name,controller,events,done});
    }
    await until(()=>streams.every(s=>s.events.length)); streams.forEach(s=>s.events.length=0);
    const {ids,request}=fixture;
    const startAt=new Date(Math.ceil(Date.now()/60000)*60000+300000).toISOString();
    const endAt=new Date(Date.parse(startAt)+3600000).toISOString();
    const segment={resourceGroupId:ids.group1,startAt,endAt};
    const created=await request("owner","/reservations/batch","POST",{segments:[segment]});
    assert.equal(created.status,201,JSON.stringify(created.body));
    await until(()=>streams[0].events.length&&streams[1].events.length);
    await delay(250);
    assert.equal(streams[2].events.length,0);
    assert.deepEqual(streams[1].events.flatMap(e=>e.scopes.map(s=>s.topic)),["timeline"]);
    assert(streams[0].events.some(e=>e.scopes.some(s=>s.topic==="ownReservations")));
    const detail=await request("owner","/reservations/mine/"+created.body.reservations[0].id);
    const selection={id:detail.body.reservation.id,stateToken:detail.body.reservation.stateToken};
    streams.forEach(s=>s.events.length=0);
    const failed=await request("owner","/reservations/batch","POST",{replaceReservations:[selection],segments:[segment,segment]});
    assert(failed.status>=400);await delay(250);assert(streams.every(s=>s.events.length===0));
    const replaced=await request("owner","/reservations/batch","POST",{replaceReservations:[selection],segments:[{...segment,resourceGroupId:ids.group2}]});
    assert.equal(replaced.status,201,JSON.stringify(replaced.body));
    await until(()=>streams[1].events.length&&streams[2].events.length);
    assert(streams[1].events.some(e=>e.scopes.some(s=>s.machineId===ids.machine1)));
    assert(streams[2].events.some(e=>e.scopes.some(s=>s.machineId===ids.machine2)));
    const token=await request("owner","/auth/api-tokens","POST",{name:"Realtime acceptance",accessLevel:"READ_WRITE",expiresInDays:null,currentPassword:fixture.password});
    assert.equal(token.status,201);
    const official=async(action,body)=>{
      const response=await fetch(fixture.origin+"/api/open/v1/reservation-operations/"+action,{method:"POST",headers:{authorization:`Bearer ${token.body.secret}`,"content-type":"application/json"},body:JSON.stringify(body)});
      const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
    };
    const prepared=await official("prepare",{action:"CREATE",segments:[{...segment,scope:"RESOURCE_GROUP",startMode:"SCHEDULED"}]});
    await delay(250);streams.forEach(s=>s.events.length=0);
    const confirmationToken=prepared.data.confirmationToken;
    assert.equal((await official("commit",{confirmationToken})).meta.replayed,false);
    await until(()=>streams[1].events.length);await delay(250);
    assert.equal(streams[2].events.length,0);
    streams.forEach(s=>s.events.length=0);
    assert.equal((await official("commit",{confirmationToken})).meta.replayed,true);
    await delay(350);assert(streams.every(s=>s.events.length===0));
    streams.forEach(s=>s.events.length=0);
    const revoke=await request("Administrator",`/admin/machines/${ids.machine1}/members/${ids.peer}`,"DELETE");
    assert.equal(revoke.status,200,JSON.stringify(revoke.body));
    await until(()=>streams[1].events.some(e=>e.accessChanged));
    assert.equal((await request("peer",`/admin/machines/${ids.machine1}`)).status,403);
    const before=streams[0].events.length;
    const logout=await request("owner","/auth/logout","POST",{}); assert.equal(logout.status,200);
    await until(()=>streams[0].events.slice(before).some(e=>e.sessionEnded));
    assert(!fixture.logs().includes('"level":50'),fixture.logs());
    console.log(JSON.stringify({sseIsolation:true,atomicReplacement:true,rollbackSilent:true,officialWrite:true,idempotentReplaySilent:true,permissionRevocation:true,sessionRevocation:true}));
  } finally { for(const stream of streams) stream.controller.abort(); await Promise.all(streams.map(s=>s.done)); await fixture.close(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) await main();
