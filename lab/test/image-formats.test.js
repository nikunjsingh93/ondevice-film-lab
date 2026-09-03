"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const formats=require('../../photo-formats');
const codecs=require('../../photo-codecs');
const makeDng=require('./fixtures/dng');
const sharp=require('sharp');
const arrayBuffer=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);

test('accepts basic formats and extension-only camera RAWs, including uppercase names',()=>{
  for(const ext of ['jpg','jpeg','png','heic','heif','webp','gif','avif','bmp','tif','tiff',...formats.rawExtensions])assert.equal(formats.supported({name:'photo.'+ext.toUpperCase(),type:''}),true,ext);
  for(const ext of ['dng','cr2','cr3','arw','raf','rw2','nef'])assert.equal(formats.kind({originalname:'photo.'+ext,mimetype:'application/octet-stream'}),'raw');
  assert.equal(formats.supported({name:'readme.txt',type:'text/plain'}),false);
  assert.equal(formats.isRaw('portrait.jpeg'),false);
});

test('develops actual DNG sensor data to full-resolution opaque RGB',async()=>{
  const result=await codecs.decode(arrayBuffer(makeDng()),'raw');
  assert.equal(result.width,128);assert.equal(result.height,96);assert.equal(result.data.length,128*96*4);
  assert.equal(result.data[3],255);assert.equal(result.data.at(-1),255);
  assert.ok(new Set(result.data).size>30,'sensor gradient must produce distinct developed pixels');
});

test('rejects a corrupt RAW and can cancel a decoder',async()=>{
  await assert.rejects(codecs.decode(new ArrayBuffer(20),'raw'),/RAW|supported|could not be decoded/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(codecs.decode(arrayBuffer(makeDng()),'raw',{signal:abort.signal}),{name:'AbortError'});
});

test('decodes TIFF and applies its orientation',async()=>{
  const input=await sharp({create:{width:3,height:2,channels:3,background:'#ff0000'}}).withMetadata({orientation:6}).tiff({compression:'none'}).toBuffer();
  const image=await codecs.decode(arrayBuffer(input),'tiff');
  assert.equal(image.width,2);assert.equal(image.height,3);
  assert.ok(image.data[0]>240);assert.ok(image.data[1]<10);assert.equal(image.data[3],255);
});

test('decodes BMP channel order correctly',async()=>{
  const bmp=Buffer.alloc(58);bmp.write('BM');bmp.writeUInt32LE(58,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(1,18);bmp.writeInt32LE(1,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp[54]=30;bmp[55]=20;bmp[56]=240;
  const image=await codecs.decode(arrayBuffer(bmp),'bmp');
  assert.equal(image.width,1);assert.equal(image.height,1);assert.deepEqual([...image.data],[240,20,30,255]);
});
