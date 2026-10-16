/* GPL-3.0. Additional look definitions and atlas layout adapted from
 * nikunjsingh93/One35-Local, revision 0c34223246b7775f4c756cc83cd45a0e43149b9c.
 * Camera atlases retain their manufacturer's rights; see NOTICE.md. */
import {factoryStateFor,VIBE_PRESETS} from './core/config.js';
export const EXTRA_LOOKS={
 classic:{label:'Classic · camera',atlas:'classicv12balancelut.png'},
 mono:{label:'Monochrome · local'},
 beta:{label:'Beta · camera',atlas:'betav6princeedwardstationlut.png'},
 cine:{label:'Cine · local interpretation'},
 gold:{label:'Gold · camera',atlas:'goldwithrgbcurvesv2lut.png'},
 retro:{label:'Retro Haze · camera',atlas:'purpleorangeretrohazev2lut.png'},
 dispo:{label:'Dispo · camera',atlas:'rawed_disposable_evm075lut.png'},
 dmg:{label:'DMG · local interpretation'}
};
export function configForLook(id){
 if(Object.hasOwn(VIBE_PRESETS,id))return factoryStateFor(id);
 if(!Object.hasOwn(EXTRA_LOOKS,id))throw Error('Unknown Flashback look');
 const config=factoryStateFor('natural'),extra=EXTRA_LOOKS[id];
 if(extra.atlas){config.enable_lut=true;config.lut_path=new URL('assets/camera/'+extra.atlas,import.meta.url).href;config.lut_input_space='srgb'}
 return config;
}
export function atlasLut(bytes,width,height){
 if(width!==512||height!==512||bytes.length!==width*height*4)throw Error('Invalid Flashback camera colour atlas');
 const size=64,data=new Float32Array(size**3*3);
 for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++){
  const src=(((b>>3)*64+g)*width+(b%8)*64+r)*4,dst=((r*size+g)*size+b)*3;
  for(let c=0;c<3;c++)data[dst+c]=bytes[src+c]/255;
 }
 return {size,data,inputSpace:'srgb'};
}
const clamp=v=>Math.max(0,Math.min(1,v));
export function finishLocalLook(image,id){
 if(!['mono','cine','dmg'].includes(id))return image;
 const pixels=image.data;
 for(let i=0;i<pixels.length;i+=4){const r=pixels[i]/255,g=pixels[i+1]/255,b=pixels[i+2]/255,l=.299*r+.587*g+.114*b;let rgb;
  if(id==='mono')rgb=[l,l,l];
  else if(id==='cine')rgb=[clamp((r-.5)*1.12+.52),clamp((g-.5)*1.08+.515),clamp((b-.5)*1.05+.525)];
  else {const v=Math.round(l*3)/3;rgb=[.12+.60*v,.20+.65*v,.12+.35*v]}
  for(let c=0;c<3;c++)pixels[i+c]=rgb[c]*255;
 }
 return image;
}
