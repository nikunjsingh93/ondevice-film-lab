/* Shared import policy for the offline editor and Server Lab. */
(function(root,factory){
  const formats=factory();
  if(typeof module==='object'&&module.exports)module.exports=formats;
  else root.PhotoFormats=formats;
})(globalThis,()=>{
  const rawExtensions=['dng','cr2','cr3','crw','arw','sr2','srf','raf','rw2','raw','rwl','nef','nrw','orf','ori','pef','ptx','srw','3fr','fff','iiq','kdc','dcr','mos','mrw','erf','x3f'];
  const mimeByExtension={jpg:'image/jpeg',jpeg:'image/jpeg',jpe:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',avif:'image/avif',gif:'image/gif',bmp:'image/bmp',tif:'image/tiff',tiff:'image/tiff'};
  const extension=name=>String(name||'').split('.').pop().toLowerCase();
  const isRaw=name=>rawExtensions.includes(extension(name));
  const mime=name=>mimeByExtension[extension(name)]||(isRaw(name)?'application/octet-stream':'');
  const supported=file=>!!mime(file.name||file.originalname)||Object.values(mimeByExtension).includes(file.type||file.mimetype);
  const kind=file=>{
    const ext=extension(file.name||file.originalname),type=file.type||file.mimetype;
    if(isRaw(file.name||file.originalname))return 'raw';
    if(['heic','heif'].includes(ext)||['image/heic','image/heif'].includes(type))return 'heif';
    if(['tif','tiff'].includes(ext)||type==='image/tiff')return 'tiff';
    if(ext==='bmp'||type==='image/bmp')return 'bmp';
    return '';
  };
  // Keep Android's document-provider workaround while including extension-only RAWs.
  const accept=[...new Set(Object.values(mimeByExtension)),...Object.keys(mimeByExtension).map(ext=>'.'+ext),...rawExtensions.map(ext=>'.'+ext),'type/nonexistent'].join(',');
  return {rawExtensions,extension,isRaw,mime,supported,kind,accept};
});
