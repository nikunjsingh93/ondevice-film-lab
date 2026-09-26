(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.PhotoExif=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function readEntries(bytes){
    if(!bytes)return [];
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const base=(bytes[0]===0x49&&bytes[1]===0x49)||(bytes[0]===0x4d&&bytes[1]===0x4d)?0:10;
    if(view.byteLength<base+8)return [];
    const order=view.getUint16(base,false);
    if(order!==0x4949&&order!==0x4d4d)return [];
    const little=order===0x4949;
    const u16=o=>view.getUint16(o,little),u32=o=>view.getUint32(o,little);
    // Panasonic RW2/RWL uses 85 where normal TIFF/EXIF uses 42.
    const magic=u16(base+2);
    if(magic!==42&&magic!==85)return [];
    const sizes={1:1,2:1,3:2,4:4,5:8,7:1,9:4,10:8};
    const directory=offset=>{
      const result={};if(!offset)return result;
      const start=base+offset;
      if(start<base||start+2>view.byteLength)return result;
      const count=Math.min(u16(start),1024);
      for(let i=0;i<count;i++){
        const entry=start+2+i*12;
        if(entry+12>view.byteLength)break;
        const tag=u16(entry),type=u16(entry+2),length=u32(entry+4),size=(sizes[type]||0)*length;
        if(!size||size>65536)continue;
        const valueAt=size<=4?entry+8:base+u32(entry+8);
        if(valueAt<base||valueAt+size>view.byteLength)continue;
        result[tag]={type,length,valueAt};
      }
      return result;
    };
    const value=entry=>{
      if(!entry)return null;
      const {type,valueAt,length}=entry;
      if(type===2){let result="";for(let i=0;i<length&&view.getUint8(valueAt+i);i++)result+=String.fromCharCode(view.getUint8(valueAt+i));return result.trim()}
      if(type===3)return u16(valueAt);
      if(type===4)return u32(valueAt);
      if(type===5||type===10){
        const numerator=type===10?view.getInt32(valueAt,little):u32(valueAt);
        const denominator=type===10?view.getInt32(valueAt+4,little):u32(valueAt+4);
        return denominator?numerator/denominator:null;
      }
      return null;
    };
    const baseIfd=directory(u32(base+4));
    const exifIfd=directory(value(baseIfd[0x8769])||0);
    const gpsIfd=directory(value(baseIfd[0x8825])||0);
    const output=[];
    const add=(label,content)=>{if(content!==null&&content!==undefined&&content!=="")output.push([label,String(content)])};
    const round=(n,d=1)=>Number(n.toFixed(d));
    add("Camera",[value(baseIfd[0x010f]),value(baseIfd[0x0110])].filter(Boolean).join(" "));
    add("Lens",value(exifIfd[0xa434]));
    add("Captured",value(exifIfd[0x9003])||value(exifIfd[0x9004])||value(baseIfd[0x0132]));
    const exposure=value(exifIfd[0x829a]);
    if(exposure)add("Shutter speed",exposure<1?`1/${Math.round(1/exposure)} s`:`${round(exposure,3)} s`);
    const aperture=value(exifIfd[0x829d]);if(aperture)add("Aperture",`f/${round(aperture)}`);
    add("ISO",value(exifIfd[0x8827])||value(baseIfd[0x0037])||value(baseIfd[0x0017]));
    const focal=value(exifIfd[0x920a]);if(focal)add("Focal length",`${round(focal)} mm`);
    const flash=value(exifIfd[0x9209]);if(flash!==null)add("Flash",flash&1?"Fired":"Did not fire");
    add("Software",value(baseIfd[0x0131]));
    if(Object.keys(gpsIfd).length)add("Location","GPS metadata present");
    return output;
  }

  return {readEntries};
});
