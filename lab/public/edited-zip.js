(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.FilmLabEditedZip=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const crcTable=new Uint32Array(256);
  for(let n=0;n<256;n++){
    let value=n;
    for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;
    crcTable[n]=value>>>0;
  }
  const readChunkSize=1024*1024;
  async function crc32(blob,signal,onChunk){
    let value=0xffffffff;
    for(let offset=0;offset<blob.size;offset+=readChunkSize){
      if(signal?.aborted)throw new DOMException("Download cancelled","AbortError");
      const bytes=new Uint8Array(await blob.slice(offset,offset+readChunkSize).arrayBuffer());
      for(let i=0;i<bytes.length;i++)value=crcTable[(value^bytes[i])&255]^(value>>>8);
      onChunk(bytes.length);
      // Allow the progress display and Cancel button to run between chunks.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return (value^0xffffffff)>>>0;
  }
  function uniqueName(name,used){
    const safe=String(name||"FilmLab.jpg").replace(/[\\/:*?"<>|]/g,"_");
    const dot=safe.lastIndexOf(".");
    const base=dot>0?safe.slice(0,dot):safe;
    const extension=dot>0?safe.slice(dot):"";
    let candidate=safe,number=2;
    while(used.has(candidate.toLowerCase()))candidate=`${base}_${number++}${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }
  async function build(entries,signal,onProgress){
    if(entries.length>65535)throw new Error("Too many photos for one ZIP file");
    const encoder=new TextEncoder(),used=new Set(),parts=[],central=[];
    const totalBytes=entries.reduce((sum,entry)=>sum+entry.blob.size,0);
    let offset=0,centralSize=0,processedBytes=0;
    for(let index=0;index<entries.length;index++){
      const entry=entries[index];
      if(signal?.aborted)throw new DOMException("Download cancelled","AbortError");
      const name=encoder.encode(uniqueName(entry.name,used));
      const size=entry.blob.size;
      if(size>0xffffffff||offset+30+name.length+size>0xffffffff)throw new Error("Selected photos exceed the ZIP size limit");
      const crc=await crc32(entry.blob,signal,chunkBytes=>{
        processedBytes+=chunkBytes;
        onProgress?.({index:index+1,count:entries.length,processedBytes,totalBytes});
      });
      if(signal?.aborted)throw new DOMException("Download cancelled","AbortError");
      const local=new Uint8Array(30+name.length),localView=new DataView(local.buffer);
      localView.setUint32(0,0x04034b50,true);
      localView.setUint16(4,20,true);
      localView.setUint16(6,0x0800,true);
      localView.setUint32(14,crc,true);
      localView.setUint32(18,size,true);
      localView.setUint32(22,size,true);
      localView.setUint16(26,name.length,true);
      local.set(name,30);
      parts.push(local,entry.blob);

      const directory=new Uint8Array(46+name.length),directoryView=new DataView(directory.buffer);
      directoryView.setUint32(0,0x02014b50,true);
      directoryView.setUint16(4,20,true);
      directoryView.setUint16(6,20,true);
      directoryView.setUint16(8,0x0800,true);
      directoryView.setUint32(16,crc,true);
      directoryView.setUint32(20,size,true);
      directoryView.setUint32(24,size,true);
      directoryView.setUint16(28,name.length,true);
      directoryView.setUint32(42,offset,true);
      directory.set(name,46);
      central.push(directory);
      centralSize+=directory.length;
      offset+=local.length+size;
    }
    if(signal?.aborted)throw new DOMException("Download cancelled","AbortError");
    if(offset+centralSize+22>0xffffffff)throw new Error("Selected photos exceed the ZIP size limit");
    const end=new Uint8Array(22),endView=new DataView(end.buffer);
    endView.setUint32(0,0x06054b50,true);
    endView.setUint16(8,entries.length,true);
    endView.setUint16(10,entries.length,true);
    endView.setUint32(12,centralSize,true);
    endView.setUint32(16,offset,true);
    return new Blob([...parts,...central,end],{type:"application/zip"});
  }
  return {build};
});
