"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"film-lut-removal-"));
process.env.DATA_DIR=path.join(root,"data");process.env.STATE_DIR=path.join(root,"state");
const {app,db,testApi}=require("../server");

test("LUT deletion removes owned files and records, but cannot remove another account's LUT",async()=>{
  const owner=testApi.defaultAdmin.id;
  db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(owner);
  const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const login=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"admin",password:"admin"})});
    const cookie=login.headers.get("set-cookie").split(";")[0];
    const form=new FormData();form.append("lut",new Blob(['LUT_1D_SIZE 2\n0 0 0\n1 1 1\n']),"identity.cube");
    const upload=await fetch(base+"/api/luts",{method:"POST",headers:{Cookie:cookie},body:form});assert.equal(upload.status,201);
    const {lut}=await upload.json(),row=testApi.statements.lutById.get(owner,lut.id);
    const file=path.join(process.env.DATA_DIR,row.stored_path);assert.ok(fs.existsSync(file));
    db.prepare("INSERT INTO users (id,username,password_hash,role,quota_bytes,must_change_password,created_at,updated_at) SELECT 'other','other',password_hash,'user',quota_bytes,0,created_at,updated_at FROM users WHERE id=?").run(owner);
    db.prepare("UPDATE luts SET user_id='other' WHERE id=?").run(lut.id);
    assert.equal((await fetch(base+`/api/luts/${lut.id}`,{method:"DELETE",headers:{Cookie:cookie}})).status,404);
    assert.ok(fs.existsSync(file));
    db.prepare("UPDATE luts SET user_id=? WHERE id=?").run(owner,lut.id);
    const unknown=await fetch(base+"/api/luts/another-account-id",{method:"DELETE",headers:{Cookie:cookie}});assert.equal(unknown.status,404);assert.ok(fs.existsSync(file));
    assert.equal((await fetch(base+`/api/luts/${lut.id}`,{method:"DELETE",headers:{Cookie:cookie}})).status,200);
    assert.equal(fs.existsSync(file),false);assert.equal(testApi.statements.lutById.get(owner,lut.id),undefined);
    assert.equal((await fetch(base+`/api/luts/${lut.id}`,{method:"DELETE",headers:{Cookie:cookie}})).status,404);
  }finally{await new Promise(r=>server.close(r));db.close()}
});

test("browser deletion commits storage before removing its in-memory LUT",async()=>{
  const html=fs.readFileSync(path.resolve(__dirname,"../../index.html"),"utf8");
  const source=html.slice(html.indexOf("  async function removeCustomLut("),html.indexOf("  function addLutOption("));
  const map=new Map([["test",{}]]);let deleted,removed=false;
  const remove=vm.runInNewContext(source+"\nremoveCustomLut",{openLibraryDB:async()=>({transaction:()=>({objectStore:()=>({delete:id=>{deleted=id}})})}),transactionComplete:async()=>{},customLuts:map,els:{lutSelect:{querySelector:()=>({remove:()=>{removed=true}})}},CSS:{escape:id=>id},updateLutUI:()=>{}});
  await remove("test");assert.equal(deleted,"test");assert.equal(map.has("test"),false);assert.equal(removed,true);
});

test("Lab reconciles stale browser LUTs and deletes by server UUID rather than content ID",async()=>{
  const source=fs.readFileSync(path.resolve(__dirname,"../public/lab-editor.js"),"utf8");
  const local=new Set(["deleted-on-another-device"]),requests=[],window={};
  const context={window,bridge:{listLutIds:()=>[...local],importLutText:async()=>{local.add("content-id");return "content-id"},removeLut:async id=>local.delete(id)},requestJson:async(url,options)=>{requests.push([url,options?.method]);return {luts:[{id:"server-uuid",url:"/lut.cube",fileName:"test.cube"}]}},fetch:async()=>({ok:true,text:async()=>"cube"})};
  const sync=vm.runInNewContext(source.slice(source.indexOf("  const serverLutIds ="),source.indexOf("  const formatBytes ="))+"\nsyncServerLuts",context);
  await sync();assert.deepEqual([...local],["content-id"]);
  await window.filmLabRemoveLut("content-id");assert.deepEqual(requests.at(-1),["/api/luts/server-uuid","DELETE"]);
});
