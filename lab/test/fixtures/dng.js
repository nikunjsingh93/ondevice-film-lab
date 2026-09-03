"use strict";
// Small, synthetic, uncompressed RGGB DNG. No third-party photo data.
module.exports = function makeDng() {
  const width=128,height=96;
  const entries=[
    [256,4,[width]],[257,4,[height]],[258,3,[16]],[259,3,[1]],[262,3,[32803]],
    [271,2,'FilmLab\0'],[272,2,'Synthetic DNG\0'],[273,4,[0]],[274,3,[1]],
    [277,3,[1]],[278,4,[height]],[279,4,[width*height*2]],[284,3,[1]],
    [33421,3,[2,2]],[33422,1,[0,1,1,2]],
    [50706,1,[1,4,0,0]],[50707,1,[1,1,0,0]],[50708,2,'FilmLab Synthetic DNG\0'],
    [50710,1,[0,1,2]],[50711,3,[1]],[50714,3,[0]],[50717,4,[16383]],
    [50721,10,[[1,1],[0,1],[0,1],[0,1],[1,1],[0,1],[0,1],[0,1],[1,1]]],
    [50728,5,[[1,1],[1,1],[1,1]]],[50778,3,[21]]
  ].sort((a,b)=>a[0]-b[0]);
  const sizes={1:1,2:1,3:2,4:4,5:8,10:8};
  const encode=(type,values)=>{
    if(type===2)return Buffer.from(values);
    const out=Buffer.alloc(values.length*sizes[type]);
    values.forEach((v,i)=>{const o=i*sizes[type];if(type===1)out[o]=v;else if(type===3)out.writeUInt16LE(v,o);else if(type===4)out.writeUInt32LE(v,o);else{out.writeInt32LE(v[0],o);out.writeInt32LE(v[1],o+4)}});
    return out;
  };
  let offset=8+2+entries.length*12+4;
  const records=entries.map(([tag,type,values])=>{const bytes=encode(type,values),record={tag,type,count:values.length,bytes,offset};if(bytes.length>4)offset+=bytes.length+(bytes.length%2);return record});
  records.find(r=>r.tag===273).bytes.writeUInt32LE(offset);
  const out=Buffer.alloc(offset+width*height*2);out.write('II');out.writeUInt16LE(42,2);out.writeUInt32LE(8,4);out.writeUInt16LE(records.length,8);
  records.forEach((r,i)=>{const o=10+i*12;out.writeUInt16LE(r.tag,o);out.writeUInt16LE(r.type,o+2);out.writeUInt32LE(r.count,o+4);if(r.bytes.length<=4)r.bytes.copy(out,o+8);else{out.writeUInt32LE(r.offset,o+8);r.bytes.copy(out,r.offset)}});
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)out.writeUInt16LE(1500+x*45+y*15,offset+(y*width+x)*2);
  return out;
};
