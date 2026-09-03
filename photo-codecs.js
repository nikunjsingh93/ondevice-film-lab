/* One isolated worker per file: release decoder memory after conversion. */
(function(root){
  const node=typeof module==='object'&&module.exports;
  const WorkerClass=node?require('node:worker_threads').Worker:root.Worker;
  const workerURL=node?require('node:url').pathToFileURL(require('node:path').join(__dirname,'codecs/decode-worker.mjs')):new URL('codecs/decode-worker.mjs',document.currentScript.src);
  function decode(buffer,kind,{signal}={}){
    return new Promise((resolve,reject)=>{
      if(!WorkerClass){reject(new Error('This browser does not support the photo decoder.'));return}
      const worker=new WorkerClass(workerURL,{type:'module'});
      let settled=false;
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);worker.terminate();error?reject(error):resolve(result)};
      const timer=setTimeout(()=>finish(new Error('Photo decoding took too long. Try a smaller file or another RAW compression setting.')),180000);
      const abort=()=>finish(new DOMException("Photo import cancelled","AbortError"));
      signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted){abort();return}
      const receive=data=>data.error?finish(new Error(data.error)):finish(null,data);
      if(node){worker.on('message',receive);worker.on('error',error=>finish(error));worker.on('exit',code=>{if(!settled)finish(new Error(`Photo decoder stopped (${code}).`))})}
      else{worker.onmessage=event=>receive(event.data);worker.onerror=event=>finish(new Error(event.message||'Photo decoder could not start.'))}
      worker.postMessage({buffer,kind},[buffer]);
    });
  }
  if(node)module.exports={decode};else root.PhotoCodecs={decode};
})(globalThis);
