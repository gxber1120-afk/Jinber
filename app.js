const DB_NAME='x-video-vault-db', DB_VERSION=5, STORE='videos', LEGACY_ALBUM_STORE='categories', ALBUM_STORE='albumsV2', LOCAL_STORE='localVideos', BLOB_STORE='localBlobs';
const ALL='__all__', NONE='__none__';
let db, allVideos=[], localVideos=[], albums=[], deferredInstallPrompt=null, editing=null, addMode='x', thumbBusy=false, pickCtx=null, pickSet=new Set(), seq=0;
const sel={add:[],edit:[]};
let urlBag=[]; const localUrls=new Map();
const $=id=>document.getElementById(id);

/* ================= IndexedDB ================= */
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const d=r.result;
  if(!d.objectStoreNames.contains(STORE))d.createObjectStore(STORE,{keyPath:'id'}).createIndex('createdAt','createdAt');
  if(!d.objectStoreNames.contains(LEGACY_ALBUM_STORE))d.createObjectStore(LEGACY_ALBUM_STORE,{keyPath:'name'});
  if(!d.objectStoreNames.contains(ALBUM_STORE))d.createObjectStore(ALBUM_STORE,{keyPath:'id'});
  if(!d.objectStoreNames.contains(LOCAL_STORE))d.createObjectStore(LOCAL_STORE,{keyPath:'id'}).createIndex('createdAt','createdAt');
  if(!d.objectStoreNames.contains(BLOB_STORE))d.createObjectStore(BLOB_STORE,{keyPath:'id'});};
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
const req=r=>new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
const txDone=t=>new Promise((res,rej)=>{t.oncomplete=()=>res();t.onerror=t.onabort=()=>rej(t.error);});
const tx=(store,mode='readonly')=>db.transaction(store,mode).objectStore(store);
const byNewest=(a,b)=>b.createdAt-a.createdAt;
const getAll=async()=>(await req(tx(STORE).getAll())).sort(byNewest);
const save=v=>req(tx(STORE,'readwrite').put(v));
const remove=id=>req(tx(STORE,'readwrite').delete(id));
const getAllLocal=async()=>(await req(tx(LOCAL_STORE).getAll())).sort(byNewest);
const saveLocal=v=>req(tx(LOCAL_STORE,'readwrite').put(v));
function removeLocal(id){const t=db.transaction([LOCAL_STORE,BLOB_STORE],'readwrite');t.objectStore(LOCAL_STORE).delete(id);t.objectStore(BLOB_STORE).delete(id);return txDone(t);}
function saveBlob(id,blob){const t=db.transaction(BLOB_STORE,'readwrite');t.objectStore(BLOB_STORE).put({id,blob});return txDone(t);}
async function getBlob(id){const r=await req(tx(BLOB_STORE).get(id));return r?r.blob:null;}
async function tryStore(id,file){try{await saveBlob(id,file);return true;}catch(err){console.error(err);return false;}}
const getAlbums=()=>req(tx(ALBUM_STORE).getAll());
const saveAlbum=a=>req(tx(ALBUM_STORE,'readwrite').put(a));
const deleteAlbumRec=id=>req(tx(ALBUM_STORE,'readwrite').delete(id));
const saveItem=(kind,v)=>kind==='x'?save(v):saveLocal(v);

/* ================= album tree ================= */
const uuid=()=>crypto.randomUUID();
const albumById=id=>albums.find(a=>a.id===id);
const parentOf=a=>a.parentId||null;
function sortAlbums(){albums.sort((a,b)=>((a.createdAt||0)-(b.createdAt||0))||a.name.localeCompare(b.name,'zh-Hant'));}
const childrenOf=pid=>albums.filter(a=>parentOf(a)===pid);
function pathOf(id){const out=[],seen=new Set();let a=albumById(id);while(a&&!seen.has(a.id)){seen.add(a.id);out.unshift(a);a=a.parentId?albumById(a.parentId):null;}return out;}
const pathText=id=>pathOf(id).map(a=>a.name).join(' › ');
function descendantIds(id){const out=new Set([id]);let grew=true;while(grew){grew=false;for(const a of albums)if(a.parentId&&out.has(a.parentId)&&!out.has(a.id)){out.add(a.id);grew=true;}}return out;}
function flatTree(exclude=new Set()){const out=[];const walk=(pid,depth)=>{for(const a of childrenOf(pid)){if(exclude.has(a.id))continue;out.push({a,depth});walk(a.id,depth+1);}};walk(null,0);return out;}
const liveIds=v=>(v.albumIds||[]).filter(id=>albumById(id));
function effTags(v){return [...new Set(liveIds(v).flatMap(id=>pathOf(id).map(a=>a.name)))];}
async function createAlbum(name,parentId){const a={id:uuid(),name,parentId:parentId||null,cover:null,createdAt:Date.now()+(seq++)};await saveAlbum(a);albums.push(a);sortAlbums();return a;}
async function getOrCreatePath(names,parentId=null){let cur=null,pid=parentId;for(const n of names){cur=albums.find(a=>parentOf(a)===pid&&a.name===n)||await createAlbum(n,pid);pid=cur.id;}return cur;}
const items=()=>[...allVideos.map(v=>({kind:'x',v})),...localVideos.map(v=>({kind:'local',v}))];
function itemsIn(key){
  const all=items();if(key===ALL)return all;if(key===NONE)return all.filter(i=>!liveIds(i.v).length);
  const ids=descendantIds(key);return all.filter(i=>liveIds(i.v).some(id=>ids.has(id)));
}

/* ================= helpers ================= */
function formatBytes(n){if(!Number.isFinite(n)||n<0)return '大小未知';if(n<1024)return n+' B';const u=['KB','MB','GB','TB'];let v=n/1024,i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(v>=100?0:1)+' '+u[i];}
function normalizeXUrl(raw){try{const u=new URL(raw.trim());if(!['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com'].includes(u.hostname.toLowerCase()))return null;const m=u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);if(!m)return null;return `https://x.com/${m[1]}/status/${m[2]}`;}catch{return null;}}
function defaultTitle(url){const m=url.match(/x\.com\/([^/]+)\/status\/(\d+)/);return m?`@${m[1]} 的影片`:'X 影片';}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
const xTitle=v=>v.title||defaultTitle(v.url);
const itemTitle=i=>i.kind==='x'?xTitle(i.v):(i.v.name||'未命名影片');
function blobUrl(b){const u=URL.createObjectURL(b);urlBag.push(u);return u;}
function revokeUrls(){urlBag.forEach(u=>URL.revokeObjectURL(u));urlBag=[];}
let toastTimer;function toast(msg){const t=$('toast');t.textContent=msg;t.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.add('hidden'),3200);}
const blobToDataURL=b=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(b);});
const splitPath=s=>String(s||'').split(/[\/＞>›]/).map(t=>t.trim().replace(/^#/,'')).filter(Boolean);

/* ================= images & thumbnails ================= */
async function imageToCoverBlob(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error('image'));i.src=url;});
    const size=640,c=document.createElement('canvas');c.width=size;c.height=size;
    const s=Math.min(img.width,img.height);
    c.getContext('2d').drawImage(img,(img.width-s)/2,(img.height-s)/2,s,s,0,0,size,size);
    return await new Promise(r=>c.toBlob(r,'image/jpeg',0.85));
  }finally{URL.revokeObjectURL(url);}
}
function makeThumb(blob){return new Promise(resolve=>{
  // Attached to the page (iOS Safari is unreliable with detached <video>), tries several moments, skips near-black frames.
  const url=URL.createObjectURL(blob),v=document.createElement('video');
  v.muted=true;v.defaultMuted=true;v.playsInline=true;v.preload='auto';
  v.setAttribute('playsinline','');v.setAttribute('muted','');v.setAttribute('webkit-playsinline','');
  v.style.cssText='position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  let done=false,best=null,bestScore=-1,times=[],seekTimer=0,seeking=false;
  const timer=setTimeout(()=>finish(best),30000);
  function finish(b){if(done)return;done=true;clearTimeout(timer);clearTimeout(seekTimer);v.pause();v.removeAttribute('src');try{v.load();}catch{}v.remove();URL.revokeObjectURL(url);resolve(b);}
  function grab(){
    if(done)return;clearTimeout(seekTimer);
    try{
      if(!v.videoWidth){next();return;}
      const w=480,h=Math.max(1,Math.round(w*v.videoHeight/v.videoWidth)),c=document.createElement('canvas');c.width=w;c.height=h;
      const ctx=c.getContext('2d');ctx.drawImage(v,0,0,w,h);
      const sm=document.createElement('canvas');sm.width=sm.height=16;const sx=sm.getContext('2d');sx.drawImage(c,0,0,16,16);
      const d=sx.getImageData(0,0,16,16).data;let sum=0;for(let i=0;i<d.length;i+=4)sum+=(d[i]*0.3+d[i+1]*0.59+d[i+2]*0.11);const score=sum/256;
      c.toBlob(bl=>{if(done)return;if(bl&&score>bestScore){best=bl;bestScore=score;}if(bl&&score>=35)finish(bl);else next();},'image/jpeg',0.82);
    }catch(err){console.warn('thumb',err);next();}
  }
  function next(){
    if(done)return;if(!times.length){finish(best);return;}
    const t=times.shift();seeking=true;
    seekTimer=setTimeout(grab,4000); // some browsers never fire "seeked" – grab whatever is decoded
    try{v.currentTime=t;}catch{grab();}
  }
  v.addEventListener('seeked',()=>{if(!seeking)return;seeking=false;clearTimeout(seekTimer);setTimeout(grab,250);});
  v.addEventListener('error',()=>finish(best));
  v.addEventListener('loadedmetadata',()=>{
    const d=Number.isFinite(v.duration)&&v.duration>0?v.duration:0;
    times=d?[...new Set([Math.min(1,d/2),d*0.1,d*0.25,d*0.5,d*0.75].map(x=>Math.max(0.05,+x.toFixed(2))))]:[0.5,2,5];
    // iOS often needs playback to have started before it will paint a seeked frame
    const pr=v.play?.();if(pr&&pr.then)pr.then(()=>v.pause()).catch(()=>{});
    next();
  },{once:true});
  v.src=url;
});}
async function imageToThumbBlob(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error('image'));i.src=url;});
    const w=Math.min(640,img.width),h=Math.max(1,Math.round(w*img.height/img.width)),c=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d').drawImage(img,0,0,w,h);
    return await new Promise(r=>c.toBlob(r,'image/jpeg',0.85));
  }finally{URL.revokeObjectURL(url);}
}
function getDuration(blob){return new Promise(resolve=>{
  const url=URL.createObjectURL(blob),v=document.createElement('video');v.preload='metadata';v.muted=true;v.setAttribute('playsinline','');
  let done=false;const fin=d=>{if(done)return;done=true;clearTimeout(t);v.removeAttribute('src');try{v.load();}catch{}URL.revokeObjectURL(url);resolve(d);};
  const t=setTimeout(()=>fin(null),8000);
  v.addEventListener('loadedmetadata',()=>fin(Number.isFinite(v.duration)&&v.duration>0?Math.round(v.duration):null));
  v.addEventListener('error',()=>fin(null));v.src=url;
});}
const fmtDur=sec=>{sec=Math.max(0,Math.round(sec));const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60,p=n=>String(n).padStart(2,'0');return h?`${h}:${p(m)}:${p(s)}`:`${p(m)}:${p(s)}`;};
/* ================= duplicate detection: pixels (resolution) + content + duration ================= */
async function sampledHash(blob){
  try{
    const size=blob.size,CH=262144,offs=[0,Math.max(0,Math.floor(size/2-CH/2)),Math.max(0,size-CH)];
    const parts=[new TextEncoder().encode(size+':')];
    for(const o of offs)parts.push(new Uint8Array(await blob.slice(o,o+CH).arrayBuffer()));
    const buf=new Uint8Array(parts.reduce((t,p)=>t+p.length,0));let pos=0;for(const p of parts){buf.set(p,pos);pos+=p.length;}
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',buf))].map(b=>b.toString(16).padStart(2,'0')).join('');
  }catch(err){console.warn('hash',err);return '';}
}
function analyzeVideo(blob){return new Promise(resolve=>{
  const url=URL.createObjectURL(blob),v=document.createElement('video');
  v.muted=true;v.defaultMuted=true;v.playsInline=true;v.preload='auto';
  v.setAttribute('playsinline','');v.setAttribute('muted','');
  v.style.cssText='position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  let done=false,waiting=false,w=0,h=0,dur=null,times=[],frames=[],seekTimer=0;
  const timer=setTimeout(()=>finish(),90000);
  const cv=document.createElement('canvas');cv.width=9;cv.height=8;const cx=cv.getContext('2d',{willReadFrequently:true});
  function finish(){if(done)return;done=true;clearTimeout(timer);clearTimeout(seekTimer);v.pause();v.removeAttribute('src');try{v.load();}catch{}v.remove();URL.revokeObjectURL(url);resolve(w?{w,h,dur,frames}:null);}
  function grab(){
    if(!waiting||done)return;waiting=false;clearTimeout(seekTimer);
    try{
      cx.drawImage(v,0,0,9,8);const d=cx.getImageData(0,0,9,8).data,g=[];
      for(let i=0;i<d.length;i+=4)g.push(d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114);
      let hex='';for(let y=0;y<8;y++){let nib=0;for(let x=0;x<8;x++){nib=(nib<<1)|(g[y*9+x]>g[y*9+x+1]?1:0);if(x%4===3){hex+=nib.toString(16);nib=0;}}}
      frames.push(hex);
    }catch(err){console.warn('frame',err);}
    next();
  }
  function next(){
    if(done)return;if(!times.length){finish();return;}
    const t=times.shift();waiting=true;seekTimer=setTimeout(grab,4000);
    try{v.currentTime=t;}catch{grab();}
  }
  v.addEventListener('seeked',()=>{if(waiting){clearTimeout(seekTimer);setTimeout(grab,180);}});
  v.addEventListener('error',()=>finish());
  v.addEventListener('loadedmetadata',()=>{
    w=v.videoWidth||0;h=v.videoHeight||0;dur=Number.isFinite(v.duration)&&v.duration>0?v.duration:null;
    if(!w){finish();return;}
    times=dur?[.12,.25,.38,.5,.62,.75,.88].map(f=>+(f*dur).toFixed(2)):[0.5,2,5];
    const pr=v.play?.();if(pr&&pr.then)pr.then(()=>v.pause()).catch(()=>{});
    next();
  },{once:true});
  v.src=url;
});}
async function fingerprint(blob){
  const [a,hash]=await Promise.all([analyzeVideo(blob),sampledHash(blob)]);
  return {w:a?a.w:0,h:a?a.h:0,dur:a&&a.dur!=null?+a.dur.toFixed(2):null,frames:a?a.frames:[],hash};
}
const popc=n=>{let c=0;while(n){c+=n&1;n>>=1;}return c;};
const hexPop=h=>[...h].reduce((t,ch)=>t+popc(parseInt(ch,16)),0);
const hamming=(a,b)=>{let d=0;for(let i=0;i<16;i++)d+=popc(parseInt(a[i],16)^parseInt(b[i],16));return d;};
function contentSim(a,b){
  const n=Math.min(a.frames.length,b.frames.length);let used=0,close=0,sum=0;
  for(let i=0;i<n;i++){
    const pa=hexPop(a.frames[i]),pb=hexPop(b.frames[i]);
    if(pa<6||pa>58||pb<6||pb>58)continue; // ignore blank / flat frames
    used++;const d=hamming(a.frames[i],b.frames[i]);sum+=d;if(d<=10)close++;
  }
  if(used<3)return{score:0,match:false};
  const mean=sum/used;return{score:Math.max(0,1-mean/32),match:close/used>=0.7&&mean<=10};
}
function compareFp(o,n,oSize,nSize){
  const bytes=!!o.hash&&o.hash===n.hash&&oSize===nSize;
  const cs=contentSim(o,n);
  const px=o.w>0&&o.w===n.w&&o.h===n.h;
  const dur=o.dur!=null&&n.dur!=null&&Math.abs(o.dur-n.dur)<=0.5;
  const content=bytes||cs.match;
  return{bytes,px,dur,content,score:bytes?1:cs.score,identical:bytes||(px&&dur&&content)};
}
let cmpResolve=null;
function finishCmp(choice){const r=cmpResolve;cmpResolve=null;if($('cmpDialog').open)$('cmpDialog').close();if(r)r(choice);}
function askConflict(old,nu){return new Promise(resolve=>{
  cmpResolve=resolve;const o=old.fp,n=nu.fp,c=nu.c;
  const res=f=>f.w?`${f.w}×${f.h}`:'未知',dur=f=>f.dur!=null?fmtDur(f.dur):'未知';
  const col=(title,thumb,rows)=>`<div class="cmp-col"><div class="cmp-title">${title}</div><div class="cmp-thumb">${thumb?`<img src="${blobUrl(thumb)}" alt="">`:'<span>▶</span>'}</div>${rows.map(([k,v,d])=>`<div class="cmp-row"><span>${k}</span><b class="${d?'diff':''}">${esc(v)}</b></div>`).join('')}</div>`;
  $('cmpOld').innerHTML=col('舊影片（影片庫裡）',old.thumb,[['名稱',old.name||'',false],['檔名',old.fileName||'',old.fileName!==nu.file.name],['解析度',res(o),!c.px],['片長',dur(o),!c.dur],['檔案大小',formatBytes(old.size),old.size!==nu.file.size]]);
  $('cmpNew').innerHTML=col('新影片（這次加入）',nu.thumb,[['名稱',nu.file.name.replace(/\.[^.]+$/,''),false],['檔名',nu.file.name,old.fileName!==nu.file.name],['解析度',res(n),!c.px],['片長',dur(n),!c.dur],['檔案大小',formatBytes(nu.file.size),old.size!==nu.file.size]]);
  const line=(ok,label,detail)=>`<div class="cmp-check ${ok?'ok':'bad'}"><span>${ok?'✓':'✗'}</span><span>${label}</span><em>${esc(detail)}</em></div>`;
  $('cmpChecks').innerHTML=line(c.px,'像素（解析度）',c.px?`都是 ${res(o)}`:`${res(o)} → ${res(n)}`)+line(c.content,'影片內容',`相似度 ${Math.round(c.score*100)}%`)+line(c.dur,'影片時長',c.dur?`都是 ${dur(o)}`:`${dur(o)} → ${dur(n)}`);
  if(!$('cmpDialog').open)$('cmpDialog').showModal();
});}
$('cmpOverwrite').onclick=()=>finishCmp('overwrite');$('cmpBoth').onclick=()=>finishCmp('both');$('cmpSkip').onclick=()=>finishCmp('skip');
$('cmpDialog').addEventListener('close',()=>{if(cmpResolve){const r=cmpResolve;cmpResolve=null;r('skip');}});
$('cmpDialog').addEventListener('cancel',e=>{e.preventDefault();finishCmp('skip');});
function showResults(results){
  const label={added:'已新增',dup:'已加入影片庫',overwrite:'已覆蓋舊影片',both:'已保留兩部',skip:'已略過',attached:'已補上影片檔',failed:'空間不足，只建立索引'};
  const text=r=>r.s==='dup'?`「${r.name}」與影片庫裡的「${r.old}」像素、內容、片長都一致，沒有重複加入。`:r.s==='overwrite'?`新影片「${r.name}」已取代舊的「${r.old}」（名稱、相簿和備註沿用舊的）。`:r.s==='attached'?`「${r.name}」已補存到既有的「${r.old}」。`:`「${r.name}」`;
  $('resultList').innerHTML=results.map(r=>`<div class="res-row ${r.s}"><b>${label[r.s]}</b><span>${esc(text(r))}</span></div>`).join('');
  $('resultDialog').showModal();
}
$('resultOk').onclick=()=>$('resultDialog').close();
async function scheduleThumbs(){
  if(thumbBusy)return;thumbBusy=true;let changed=false;
  try{for(const v of localVideos){
    if(!v.hasFile)continue;const needT=!v.thumb&&(v.thumbV||0)<2,needD=v.dur==null&&!v.durTried;if(!needT&&!needD)continue;
    const blob=await getBlob(v.id);if(!blob)continue;
    if(needT){v.thumbV=2;const t=await makeThumb(blob);if(t)v.thumb=t;}
    if(needD){v.durTried=true;const d=await getDuration(blob);if(d)v.dur=d;}
    await saveLocal(v);changed=true;}}
  catch(err){console.error(err);}
  thumbBusy=false;if(changed)render();
}

/* ================= routing ================= */
const viewKey=()=>{const h=location.hash;return h.startsWith('#/album/')?decodeURIComponent(h.slice(8)):null;};
const go=key=>{location.hash=key?'#/album/'+encodeURIComponent(key):'';};
window.addEventListener('hashchange',()=>{window.scrollTo(0,0);render();});
$('backBtn').onclick=()=>{const k=viewKey();const a=k&&albumById(k);go(a&&a.parentId?a.parentId:null);};
$('crumbs').addEventListener('click',e=>{const c=e.target.closest('[data-crumb]');if(c)go(c.dataset.crumb||null);});

/* ================= render ================= */
function albumCover(key){
  if(key!==ALL&&key!==NONE){const a=albumById(key);if(a&&a.cover)return a.cover;}
  const first=itemsIn(key).find(i=>i.kind==='local'&&i.v.thumb);return first?first.v.thumb:null;
}
function tileHtml(key,title,editable){
  const n=itemsIn(key).length,cover=albumCover(key),kids=editable?childrenOf(key).length:0;
  return `<div class="album-tile" data-album="${esc(key)}" role="button" tabindex="0"><div class="album-cover">${cover?`<img src="${blobUrl(cover)}" alt="">`:`<span class="album-ph">▶</span>`}</div><div class="album-info"><div class="album-text"><div class="album-name">${esc(title)}</div><div class="album-meta">🎞 ${n}${kids?` · 📁 ${kids}`:''}</div></div>${editable?`<button class="album-menu" data-album-edit="${esc(key)}" aria-label="編輯相簿">⋮</button>`:''}</div></div>`;
}
const newTileHtml=(parentId,label)=>`<div class="album-tile album-new" data-album-new="${esc(parentId||'')}" role="button" tabindex="0"><div class="album-cover"><span class="album-ph">＋</span></div><div class="album-info"><div class="album-text"><div class="album-name">${label}</div></div></div></div>`;
function render(){
  revokeUrls();
  let key=viewKey();
  if(key&&key!==ALL&&key!==NONE&&!albumById(key)){location.replace('#');return;}
  const q=$('search').value.trim(),list=key!==null||q!=='';
  $('homeView').classList.toggle('hidden',list);$('listView').classList.toggle('hidden',!list);
  if(list)renderList(key===null?ALL:key,q,key===null);else renderHome();
  renderSel('add');renderSel('edit');
}
function renderHome(){
  $('albumGrid').innerHTML=tileHtml(ALL,'全部影片',false)+tileHtml(NONE,'未分類',false)+childrenOf(null).map(a=>tileHtml(a.id,a.name,true)).join('')+newTileHtml(null,'新增相簿');
}
function renderList(key,q,searchOnly){
  const real=key!==ALL&&key!==NONE,album=real?albumById(key):null;
  const title=searchOnly?'搜尋結果':key===ALL?'全部影片':key===NONE?'未分類':album.name;
  $('listTitle').textContent=title;
  $('backBtn').classList.toggle('hidden',searchOnly);
  $('albumEditBtn').classList.toggle('hidden',searchOnly||!real);
  // breadcrumbs
  let crumbs='<a data-crumb="">首頁</a>';
  if(real&&!searchOnly)for(const a of pathOf(key).slice(0,-1))crumbs+=` › <a data-crumb="${esc(a.id)}">${esc(a.name)}</a>`;
  if(!searchOnly)crumbs+=` › <b>${esc(title)}</b>`;
  $('crumbs').innerHTML=searchOnly?'':crumbs;
  // sub albums
  const kids=real&&!searchOnly?childrenOf(key):[];
  $('subWrap').classList.toggle('hidden',!(real&&!searchOnly&&!q&&kids.length));
  $('subGrid').innerHTML=kids.map(a=>tileHtml(a.id,a.name,true)).join('');
  $('subNewBtn').classList.toggle('hidden',!(real&&!searchOnly));
  // videos (an album includes everything inside its sub-albums)
  let list=itemsIn(key);const ql=q.toLocaleLowerCase();
  if(ql)list=list.filter(i=>[itemTitle(i),i.kind==='x'?i.v.url:i.v.fileName,i.v.notes,...effTags(i.v)].join(' ').toLocaleLowerCase().includes(ql));
  const sort=$('sort').value;
  if(sort==='oldest')list.sort((a,b)=>a.v.createdAt-b.v.createdAt);
  else if(sort==='title')list.sort((a,b)=>itemTitle(a).localeCompare(itemTitle(b),'zh-Hant'));
  else list.sort((a,b)=>b.v.createdAt-a.v.createdAt);
  $('listCount').textContent=`${list.length} 部影片${kids.length&&!q?` · ${kids.length} 個子相簿`:''}`;
  $('videoLabel').classList.toggle('hidden',!(kids.length&&!q&&list.length));
  $('empty').classList.toggle('hidden',list.length!==0||(kids.length>0&&!q));
  $('emptyText').textContent=q?'找不到符合的影片。':'這裡還沒有影片，點右下角的「＋」加入。';
  viewItems=list;$('videoGrid').innerHTML=list.map((it,i)=>thumbHTML(it,i)).join('');
}
function tagChips(v){
  const seen=new Set();let h='';
  for(const id of liveIds(v))for(const a of pathOf(id)){if(seen.has(a.id))continue;seen.add(a.id);h+=`<button class="tag" data-album-go="${esc(a.id)}">#${esc(a.name)}</button>`;}
  return `<div class="tag-list">${h}</div>`;
}
const CAM='<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="13" height="12" rx="2.5"/><path d="M15 10.5l6-3.5v10l-6-3.5z"/></svg>';
function thumbHTML(it,i){
  const v=it.v,local=it.kind==='local',title=itemTitle(it);
  const img=v.thumb?`<img src="${blobUrl(v.thumb)}" alt="" loading="lazy">`:`<span class="thumb-ph"><span>▶</span><small>${esc(title)}</small></span>`;
  return `<button type="button" class="thumb" data-view="${i}" aria-label="${esc(title)}">${img}<span class="thumb-meta"><span class="thumb-l">${local?CAM:'<b class="thumb-x">X</b>'}</span><span class="thumb-r">${local&&v.dur?fmtDur(v.dur):''}</span></span></button>`;
}
let widgetLoading=false,embedTimer;
function checkEmbeds(){document.querySelectorAll('.embed-wrap[data-x]').forEach(w=>{if(w.querySelector('iframe')||w.dataset.failed)return;w.dataset.failed='1';w.innerHTML='<div class="embed-failed">X 沒有提供這則貼文的內嵌預覽（可能是敏感內容、限制嵌入、需要登入、已刪除，或瀏覽器擋了 X 的程式）。點上方圖片可開啟原貼文，也可以按右上角「•••」自選一張封面照片。</div>';});}
function scheduleEmbedCheck(ms=12000){clearTimeout(embedTimer);embedTimer=setTimeout(checkEmbeds,ms);}
let widgetTarget=null;function loadXWidgets(el){widgetTarget=el;scheduleEmbedCheck();if(window.twttr?.widgets){window.twttr.widgets.load(el);return;}if(widgetLoading)return;widgetLoading=true;const s=document.createElement('script');s.src='https://platform.twitter.com/widgets.js';s.async=true;s.onload=()=>{widgetLoading=false;window.twttr?.widgets?.load(widgetTarget);};s.onerror=()=>{widgetLoading=false;scheduleEmbedCheck(300);};document.head.appendChild(s);}

/* ================= data load + migration from the old flat tags ================= */
async function migrateLegacy(){
  let flag=false;try{flag=!!localStorage.getItem('albumsMigratedV5');}catch{}
  if(!flag&&albums.length===0){
    const legacy=await req(tx(LEGACY_ALBUM_STORE).getAll());let i=0;
    for(const l of legacy){if(!l||!l.name||albums.some(a=>!a.parentId&&a.name===l.name))continue;const a={id:uuid(),name:l.name,parentId:null,cover:l.cover||null,createdAt:l.createdAt||++i};await saveAlbum(a);albums.push(a);}
  }
  try{localStorage.setItem('albumsMigratedV5','1');}catch{}
  for(const [kind,list] of [['x',allVideos],['local',localVideos]])for(const v of list){
    if(Array.isArray(v.tags)&&!v.albumIds){
      const ids=[];for(const t of v.tags){const name=String(t).trim();if(!name)continue;const a=await getOrCreatePath([name]);ids.push(a.id);}
      v.albumIds=[...new Set(ids)];delete v.tags;await saveItem(kind,v);
    }
  }
  sortAlbums();
}
async function refresh(){
  allVideos=await getAll();localVideos=await getAllLocal();albums=await getAlbums();sortAlbums();
  await migrateLegacy();
  render();scheduleThumbs();
}

/* ================= album picker (used by add + edit forms) ================= */
function renderSel(ctx){
  const box=$(ctx+'Sel');if(!box)return;
  sel[ctx]=sel[ctx].filter(id=>albumById(id));
  box.innerHTML=sel[ctx].length?sel[ctx].map(id=>`<span class="sel-chip">${esc(pathText(id))}<button type="button" data-sel-remove="${esc(id)}" aria-label="移除">✕</button></span>`).join(''):'<span class="muted">尚未選擇，會放在「未分類」</span>';
}
for(const ctx of ['add','edit']){
  $(ctx+'Sel').addEventListener('click',e=>{const r=e.target.closest('[data-sel-remove]');if(r){sel[ctx]=sel[ctx].filter(id=>id!==r.dataset.selRemove);renderSel(ctx);}});
  $(ctx+'PickBtn').onclick=()=>openPicker(ctx);
}
function renderPick(){
  const rows=flatTree();
  $('pickList').innerHTML=rows.length?rows.map(({a,depth})=>`<label class="pick-row" style="padding-left:${10+depth*20}px"><input type="checkbox" data-pick="${esc(a.id)}" ${pickSet.has(a.id)?'checked':''}><span>${depth?'└ ':''}${esc(a.name)}</span></label>`).join(''):'<div class="category-empty">還沒有相簿，請在下方輸入名稱新增。</div>';
}
function openPicker(ctx){pickCtx=ctx;pickSet=new Set(sel[ctx]);$('pickNewPath').value='';renderPick();$('pickDialog').showModal();}
$('pickList').addEventListener('change',e=>{const c=e.target.closest('[data-pick]');if(!c)return;c.checked?pickSet.add(c.dataset.pick):pickSet.delete(c.dataset.pick);});
$('pickNewBtn').onclick=async()=>{
  const names=splitPath($('pickNewPath').value);$('pickNewPath').value='';if(!names.length)return;
  const a=await getOrCreatePath(names);pickSet.add(a.id);renderPick();render();
};
$('pickNewPath').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('pickNewBtn').click();}});
$('pickDone').onclick=()=>{sel[pickCtx]=[...pickSet];renderSel(pickCtx);$('pickDialog').close();};
$('closePick').onclick=()=>$('pickDialog').close();

/* ================= home & list interactions ================= */
function bindTiles(el){
  el.addEventListener('click',e=>{
    const edit=e.target.closest('[data-album-edit]');if(edit){openAlbumDialog(edit.dataset.albumEdit,null);return;}
    const nw=e.target.closest('[data-album-new]');if(nw){openAlbumDialog(null,nw.dataset.albumNew||null);return;}
    const t=e.target.closest('[data-album]');if(t)go(t.dataset.album);
  });
  el.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.classList.contains('album-tile')){e.preventDefault();e.target.click();}});
}
bindTiles($('albumGrid'));bindTiles($('subGrid'));
$('search').addEventListener('input',render);$('sort').addEventListener('change',render);
$('subNewBtn').onclick=()=>{const k=viewKey();if(k&&albumById(k))openAlbumDialog(null,k);};
$('albumEditBtn').onclick=()=>{const k=viewKey();if(k&&albumById(k))openAlbumDialog(k,null);};

/* ================= viewer (tap a thumbnail) ================= */
let viewItems=[],viewIdx=-1,viewUrl=null,viewSeq=0;
function cleanupViewer(){const v=$('viewBody').querySelector('video');if(v){v.pause();v.removeAttribute('src');try{v.load();}catch{}}if(viewUrl){URL.revokeObjectURL(viewUrl);viewUrl=null;}$('viewBody').innerHTML='';}
async function openViewer(i){
  const it=viewItems[i];if(!it)return;const seq=++viewSeq;viewIdx=i;cleanupViewer();
  const v=it.v;
  $('viewTitle').textContent=itemTitle(it);$('viewPos').textContent=`${i+1} / ${viewItems.length}`;
  $('viewPrev').disabled=i<=0;$('viewNext').disabled=i>=viewItems.length-1;
  $('viewInfo').innerHTML=tagChips(v)+(v.notes?`<div class="notes">${esc(v.notes)}</div>`:'')+`<div class="viewer-meta">${new Date(v.createdAt).toLocaleDateString('zh-TW')}${it.kind==='local'?` · ${esc(formatBytes(v.size))}${v.dur?` · ${fmtDur(v.dur)}`:''}`:''}</div>`;
  if(!$('viewDialog').open)$('viewDialog').showModal();
  const body=$('viewBody');
  if(it.kind==='x'){
    body.innerHTML=`<div class="embed-wrap" data-x><blockquote class="twitter-tweet" data-dnt="true" data-conversation="none"><a href="${esc(v.url)}"></a></blockquote></div><a class="viewer-open" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">開啟原貼文 ↗</a>`;
    loadXWidgets(body);return;
  }
  let blob=null;if(v.hasFile){try{blob=await getBlob(v.id);}catch(err){console.error(err);}}
  if(seq!==viewSeq)return;
  if(!blob){
    if(v.hasFile){v.hasFile=false;await saveLocal(v);}
    body.innerHTML='<div class="viewer-missing"><p>這部影片還沒有存進瀏覽器。</p><button type="button" id="viewPick">選取並存入影片</button></div>';return;
  }
  viewUrl=URL.createObjectURL(blob);
  const video=document.createElement('video');video.controls=true;video.autoplay=true;video.playsInline=true;video.setAttribute('playsinline','');video.src=viewUrl;
  if(v.thumb)video.poster=blobUrl(v.thumb);
  video.addEventListener('error',()=>{body.innerHTML='<div class="viewer-missing"><p>這個瀏覽器無法播放此影片格式（例如 mkv）。</p></div>';});
  body.appendChild(video);video.play?.().catch(()=>{});
}
$('videoGrid').addEventListener('click',e=>{const t=e.target.closest('[data-view]');if(t)openViewer(+t.dataset.view);});
$('viewClose').onclick=()=>$('viewDialog').close();
$('viewDialog').addEventListener('close',()=>{viewSeq++;cleanupViewer();});
$('viewPrev').onclick=()=>openViewer(viewIdx-1);$('viewNext').onclick=()=>openViewer(viewIdx+1);
$('viewEdit').onclick=()=>{const it=viewItems[viewIdx];if(!it)return;$('viewDialog').close();openEdit(it.kind,it.v.id);};
$('viewInfo').addEventListener('click',e=>{const g=e.target.closest('[data-album-go]');if(g){$('viewDialog').close();go(g.dataset.albumGo);}});
$('viewBody').addEventListener('click',e=>{if(e.target.closest('#viewPick'))$('viewFile').click();});
$('viewFile').addEventListener('change',async e=>{
  const f=e.target.files[0];e.target.value='';const it=viewItems[viewIdx];if(!f||!it||it.kind!=='local')return;const v=it.v;
  navigator.storage?.persist?.().catch(()=>{});
  if(await tryStore(v.id,f)){v.hasFile=true;if(!v.thumb){const t=await makeThumb(f);if(t)v.thumb=t;}v.thumbV=2;const d=await getDuration(f);if(d)v.dur=d;v.fp=await fingerprint(f);await saveLocal(v);}
  else{alert('無法存入瀏覽器（可能空間不足）。');return;}
  await refresh();const idx=viewItems.findIndex(x=>x.kind==='local'&&x.v.id===v.id);openViewer(idx>=0?idx:0);
});

/* ================= add dialog ================= */
function setAddMode(m){addMode=m;$('tabX').classList.toggle('secondary',m!=='x');$('tabLocal').classList.toggle('secondary',m!=='local');$('rowX').classList.toggle('hidden',m!=='x');$('rowLocal').classList.toggle('hidden',m!=='local');$('formError').textContent='';}
function openAdd(){
  $('addForm').reset();$('formError').textContent='';setAddMode('x');
  const k=viewKey();sel.add=(k&&k!==ALL&&k!==NONE&&albumById(k))?[k]:[];
  renderSel('add');$('addDialog').showModal();
}
$('fab').onclick=openAdd;$('closeAdd').onclick=()=>$('addDialog').close();
$('tabX').onclick=()=>setAddMode('x');$('tabLocal').onclick=()=>setAddMode('local');
$('addForm').addEventListener('submit',async e=>{
  e.preventDefault();const err=$('formError');err.textContent='';
  const albumIds=[...sel.add],notes=$('addNotes').value.trim(),title=$('addTitle').value.trim();
  const btn=$('addSubmit');
  try{
    if(addMode==='x'){
      const url=normalizeXUrl($('postUrl').value);
      if(!url){err.textContent='請貼上有效的 X／Twitter 貼文網址，格式需包含 /status/ 及貼文編號。';return;}
      if(allVideos.some(v=>v.url===url)){err.textContent='這個連結已經收藏過了。';return;}
      await save({id:uuid(),url,title:title.slice(0,160)||defaultTitle(url),albumIds,notes,createdAt:Date.now()});
      $('addDialog').close();await refresh();toast('已加入收藏');
    }else{
      const files=[...($('addFiles').files||[])];
      if(!files.length){err.textContent='請先選擇要加入的影片。';return;}
      btn.disabled=true;navigator.storage?.persist?.().catch(()=>{});
      const results=[];let n=0;
      const setMsg=t=>{err.textContent=t;err.classList.add('info');};
      // make sure the existing library has fingerprints, so new files can be compared against it (one-time)
      const need=localVideos.filter(v=>v.hasFile&&!v.fp);let k=0;
      for(const v of need){setMsg(`分析影片庫裡的既有影片 ${++k}/${need.length}…`);const bl=await getBlob(v.id);if(bl){v.fp=await fingerprint(bl);await saveLocal(v);}}
      for(const f of files){
        n++;setMsg(`分析影片 ${n}/${files.length}：${f.name}`);
        const name=(files.length===1&&title)?title.slice(0,200):(f.name.replace(/\.[^.]+$/,'')||f.name);
        const fp=await fingerprint(f);
        // same file name + size but no stored copy yet → just attach the video to that entry
        const sameFile=localVideos.find(v=>!v.hasFile&&v.fileName===f.name&&v.size===f.size);
        if(sameFile){
          if(await tryStore(sameFile.id,f)){sameFile.hasFile=true;const t=await makeThumb(f);if(t)sameFile.thumb=t;sameFile.thumbV=2;sameFile.fp=fp;if(fp.dur!=null)sameFile.dur=Math.round(fp.dur);await saveLocal(sameFile);results.push({s:'attached',name,old:sameFile.name});}
          else results.push({s:'failed',name});
          continue;
        }
        // compare with the library: pixels + content + duration
        let best=null;
        for(const v of localVideos){if(!v.hasFile||!v.fp)continue;const c=compareFp(v.fp,fp,v.size,f.size);if(c.content&&(!best||c.score>best.c.score))best={v,c};}
        if(best&&best.c.identical){results.push({s:'dup',name,old:best.v.name});continue;}
        let thumb=null,choice='new';
        if(best){ // same content but different pixels / duration → let the user decide
          thumb=await makeThumb(f);
          choice=await askConflict(best.v,{file:f,fp,thumb,c:best.c});
          if(choice==='skip'){results.push({s:'skip',name});continue;}
          if(choice==='overwrite'){
            const o=best.v;
            if(await tryStore(o.id,f)){o.size=f.size;o.fileName=f.name;o.type=f.type||'video/*';o.fp=fp;if(fp.dur!=null)o.dur=Math.round(fp.dur);if(thumb)o.thumb=thumb;o.thumbV=2;o.hasFile=true;await saveLocal(o);results.push({s:'overwrite',name,old:o.name});}
            else results.push({s:'failed',name});
            continue;
          }
        }
        const id=uuid(),stored=await tryStore(id,f);
        if(stored&&!thumb)thumb=await makeThumb(f);
        const dur=stored?(fp.dur!=null?Math.round(fp.dur):await getDuration(f)):null;
        const rec={id,name,fileName:f.name,size:f.size,type:f.type||'video/*',hasFile:stored,thumb:stored?thumb:null,thumbV:2,dur,fp:stored?fp:null,albumIds,notes,createdAt:Date.now()};
        await saveLocal(rec);localVideos.push(rec);
        results.push({s:stored?(choice==='both'?'both':'added'):'failed',name});
      }
      err.classList.remove('info');err.textContent='';
      $('addDialog').close();await refresh();
      if(results.every(r=>r.s==='added'))toast(results.length>1?`已存入 ${results.length} 部影片，點縮圖即可播放`:'已存入瀏覽器，點縮圖即可播放');
      else showResults(results);
    }
  }catch(ex){console.error(ex);err.textContent='無法儲存，請確認瀏覽器儲存空間是否可用。';}
  finally{btn.disabled=false;}
});

/* ================= edit video dialog ================= */
function openEdit(kind,id){
  const v=(kind==='x'?allVideos:localVideos).find(x=>x.id===id);if(!v)return;
  editing={kind,id};
  $('editTitle').value=kind==='x'?(v.title||''):(v.name||'');
  $('editNotes').value=v.notes||'';sel.edit=liveIds(v);
  paintEditCover(v);
  renderSel('edit');$('editDialog').showModal();
}
function paintEditCover(v){
  const isX=editing&&editing.kind==='x';
  $('editCoverPreview').innerHTML=v.thumb?`<img src="${blobUrl(v.thumb)}" alt="">`:'<span class="album-ph">▶</span>';
  $('editCoverRegen').classList.toggle('hidden',isX);$('editCoverClear').classList.toggle('hidden',!v.thumb);
  $('editCoverMsg').textContent=v.thumb?'':(isX?'X 有些貼文（敏感內容、限制嵌入等）無法顯示預覽，可以自己選一張照片當封面。':(v.hasFile?'這部影片還沒有預覽畫面，可以重新擷取，或自己選一張照片。':'請先在卡片上「選取並存入影片」，或自己選一張照片當封面。'));
}
const editingItem=()=>editing?(editing.kind==='x'?allVideos:localVideos).find(x=>x.id===editing.id)||null:null;
$('editCoverPick').onclick=()=>$('editCoverInput').click();
$('editCoverInput').addEventListener('change',async e=>{
  const f=e.target.files[0];e.target.value='';const v=editingItem();if(!f||!v)return;
  try{v.thumb=await imageToThumbBlob(f);v.thumbV=2;await saveItem(editing.kind,v);paintEditCover(v);render();}
  catch(err){console.error(err);alert('無法讀取這張圖片，請換一張（建議 JPG 或 PNG）。');}
});
$('editCoverClear').onclick=async()=>{const v=editingItem();if(!v)return;v.thumb=null;v.thumbV=2;await saveItem(editing.kind,v);paintEditCover(v);render();};
$('editCoverRegen').onclick=async()=>{
  const v=editingItem();if(!v||editing.kind!=='local')return;
  const btn=$('editCoverRegen');btn.disabled=true;$('editCoverMsg').textContent='擷取中…';
  try{
    const blob=await getBlob(v.id);
    if(!blob){$('editCoverMsg').textContent='影片尚未存入瀏覽器，請先在卡片上「選取並存入影片」。';return;}
    const t=await makeThumb(blob);
    if(t){v.thumb=t;v.thumbV=2;if(v.dur==null){const dd=await getDuration(blob);if(dd)v.dur=dd;}await saveLocal(v);paintEditCover(v);render();}
    else $('editCoverMsg').textContent='這個瀏覽器無法擷取這部影片的畫面（可能是格式不支援），請改用「選擇照片」自訂封面。';
  }finally{btn.disabled=false;}
};
$('closeDialog').onclick=()=>$('editDialog').close();
$('editForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!editing)return;
  const {kind,id}=editing,v=(kind==='x'?allVideos:localVideos).find(x=>x.id===id);if(!v)return;
  const title=$('editTitle').value.trim();
  if(kind==='x')v.title=title.slice(0,160)||defaultTitle(v.url);else v.name=title.slice(0,200)||v.fileName||v.name;
  v.albumIds=[...sel.edit];v.notes=$('editNotes').value.trim();
  await saveItem(kind,v);$('editDialog').close();await refresh();
});
$('deleteBtn').addEventListener('click',async()=>{
  if(!editing)return;const {kind,id}=editing;
  if(!confirm(kind==='x'?'確定刪除此收藏？':'確定刪除此本機影片？存在瀏覽器裡的影片也會一併刪除，原始檔案不受影響。'))return;
  if(kind==='x')await remove(id);else await removeLocal(id);
  $('editDialog').close();await refresh();
});

/* ================= album dialog (create / rename / move / cover / delete) ================= */
let settingsId=null,nameCtx=null;
function openAlbumDialog(id,parentId){if(id)openSettings(id);else openNameDialog({mode:'create',parentId:parentId||null});}
/* --- album settings page (tap ⋮ on an album) --- */
function albumBytes(id){return itemsIn(id).reduce((t,i)=>t+(i.kind==='local'&&i.v.hasFile?(Number(i.v.size)||0):0),0);}
function paintSettings(){
  const a=settingsId?albumById(settingsId):null;if(!a){if($('albumSettings').open)$('albumSettings').close();return;}
  $('setNameVal').textContent=a.name;
  $('setCoverThumb').innerHTML=a.cover?`<img src="${blobUrl(a.cover)}" alt="">`:(albumCover(a.id)?`<img src="${blobUrl(albumCover(a.id))}" alt="">`:'<span>▶</span>');
  $('setCoverClear').classList.toggle('hidden',!a.cover);
  const exclude=descendantIds(a.id);
  $('setParent').innerHTML='<option value="">（最上層）</option>'+flatTree(exclude).map(({a:x,depth})=>`<option value="${esc(x.id)}">${'　'.repeat(depth)}${esc(x.name)}</option>`).join('');
  $('setParent').value=a.parentId||'';
  $('setParentVal').textContent=a.parentId?pathText(a.parentId):'最上層';
  const n=itemsIn(a.id).filter(i=>i.kind==='local'&&i.v.hasFile).length;
  $('setSize').textContent=formatBytes(albumBytes(a.id));
  $('setSizeNote').textContent=n?`${n} 部本機影片（含子相簿）`:'只計算存在瀏覽器裡的本機影片';
}
function openSettings(id){settingsId=id;paintSettings();if(!$('albumSettings').open)$('albumSettings').showModal();}
$('setClose').onclick=()=>$('albumSettings').close();
$('albumSettings').addEventListener('close',()=>{settingsId=null;});
$('setName').onclick=()=>{const a=albumById(settingsId);if(a)openNameDialog({mode:'rename',id:a.id,value:a.name});};
$('setCover').onclick=()=>$('setCoverInput').click();
$('setCoverInput').addEventListener('change',async e=>{
  const f=e.target.files[0];e.target.value='';const a=albumById(settingsId);if(!f||!a)return;
  try{a.cover=await imageToCoverBlob(f);await saveAlbum(a);await refresh();paintSettings();}
  catch(err){console.error(err);alert('無法讀取這張圖片，請換一張（建議 JPG 或 PNG）。');}
});
$('setCoverClear').onclick=async()=>{const a=albumById(settingsId);if(!a)return;a.cover=null;await saveAlbum(a);await refresh();paintSettings();};
$('setParent').addEventListener('change',async()=>{
  const a=albumById(settingsId);if(!a)return;const pid=$('setParent').value||null;
  if(albums.some(x=>x.id!==a.id&&parentOf(x)===pid&&x.name===a.name)){alert('目的地已經有同名的相簿。');paintSettings();return;}
  a.parentId=pid;await saveAlbum(a);await refresh();paintSettings();
});
$('setDelete').onclick=async()=>{
  const a=albumById(settingsId);if(!a)return;
  const ids=descendantIds(a.id),subs=ids.size-1;
  if(!confirm(`刪除相簿「${a.name}」${subs?`與它底下的 ${subs} 個子相簿`:''}？影片不會被刪除，只會從相簿移除（沒有其他相簿的影片會變成「未分類」）。`))return;
  for(const [kind,list] of [['x',allVideos],['local',localVideos]])for(const v of list)if((v.albumIds||[]).some(id=>ids.has(id))){v.albumIds=v.albumIds.filter(id=>!ids.has(id));await saveItem(kind,v);}
  for(const id of ids)await deleteAlbumRec(id);
  albums=albums.filter(x=>!ids.has(x.id));
  $('albumSettings').close();
  const k=viewKey();if(k&&ids.has(k))go(a.parentId||null);
  await refresh();toast('已刪除相簿');
};
/* --- small "rename / new album" window --- */
function updateNameSave(){const v=$('nameInput').value.trim().replace(/^#/,'');const ok=!!v&&!(nameCtx&&nameCtx.mode==='rename'&&v===nameCtx.value);$('nameSave').classList.toggle('on',ok);}
function openNameDialog(ctx){nameCtx=ctx;$('nameTitle').textContent=ctx.mode==='create'?(ctx.parentId?'新增子相簿':'新增相簿'):'重新命名相簿';$('nameInput').value=ctx.value||'';$('nameInput').placeholder=ctx.mode==='create'?'新相簿名稱':'新相簿名稱';updateNameSave();$('nameDialog').showModal();setTimeout(()=>{$('nameInput').focus();$('nameInput').select();},60);}
$('nameInput').addEventListener('input',updateNameSave);
$('nameClose').onclick=()=>$('nameDialog').close();
$('nameForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!nameCtx)return;
  const name=$('nameInput').value.trim().replace(/^#/,'').slice(0,40);if(!name)return;
  try{
    if(nameCtx.mode==='create'){
      if(albums.some(a=>parentOf(a)===nameCtx.parentId&&a.name===name))return alert('這一層已經有同名的相簿。');
      await createAlbum(name,nameCtx.parentId);$('nameDialog').close();await refresh();toast('已新增相簿');
    }else{
      const a=albumById(nameCtx.id);if(!a)return;if(name===a.name){$('nameDialog').close();return;}
      if(albums.some(x=>x.id!==a.id&&parentOf(x)===parentOf(a)&&x.name===name))return alert('這一層已經有同名的相簿。');
      a.name=name;await saveAlbum(a);$('nameDialog').close();await refresh();paintSettings();
    }
  }catch(err){console.error(err);alert('儲存失敗，請確認瀏覽器儲存空間。');}
});

/* ================= backup ================= */
$('moreBtn').onclick=()=>$('moreDialog').showModal();$('closeMore').onclick=()=>$('moreDialog').close();
$('exportBtn').onclick=async()=>{
  const albumData=[];for(const a of albums)albumData.push({id:a.id,name:a.name,parentId:a.parentId||null,createdAt:a.createdAt||0,cover:a.cover?await blobToDataURL(a.cover):null});
  const xVideos=[];for(const v of allVideos){const {thumb,thumbV,...r}=v;xVideos.push(thumb?{...r,thumb:await blobToDataURL(thumb)}:r);}
  const data={format:'x-video-vault-backup',version:7,exportedAt:new Date().toISOString(),albums:albumData,videos:xVideos,localVideos:localVideos.map(({hasFile,thumb,thumbTried,thumbV,durTried,fp,...r})=>r)};
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));
  a.download=`x-video-vault-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};
$('importBtn').onclick=()=>$('importFile').click();
$('importFile').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try{
    const data=JSON.parse(await file.text());if(!Array.isArray(data.videos))throw new Error('格式不正確');
    const map=new Map();let added=0,localAdded=0;
    // album tree (new backups) – parents first
    if(Array.isArray(data.albums)){
      const list=data.albums.filter(a=>a&&a.name);let pending=[...list];
      while(pending.length){
        const rest=[];
        for(const a of pending){
          const pid=a.parentId||null;
          if(pid&&!map.has(pid)&&list.some(x=>x.id===pid)){rest.push(a);continue;}
          const parent=pid?(map.get(pid)||null):null;
          let ex=albums.find(x=>parentOf(x)===parent&&x.name===String(a.name));
          if(!ex){let cover=null;if(a.cover)try{cover=await (await fetch(a.cover)).blob();}catch{}ex={id:uuid(),name:String(a.name).slice(0,40),parentId:parent,cover,createdAt:Number(a.createdAt)||Date.now()+(seq++)};await saveAlbum(ex);albums.push(ex);}
          map.set(a.id,ex.id);
        }
        if(rest.length===pending.length)break;pending=rest;
      }
    }
    // old backups: flat tags / categories become top-level albums
    if(Array.isArray(data.categories))for(const n of data.categories){const nm=String(n).trim();if(nm)await getOrCreatePath([nm]);}
    const idsFor=async raw=>{
      const ids=(Array.isArray(raw.albumIds)?raw.albumIds:[]).map(i=>map.get(i)).filter(Boolean);
      if(Array.isArray(raw.tags))for(const t of raw.tags){const nm=String(t).trim();if(nm)ids.push((await getOrCreatePath([nm])).id);}
      return [...new Set(ids)];
    };
    for(const raw of data.videos){
      const url=normalizeXUrl(raw.url||'');if(!url||allVideos.some(v=>v.url===url))continue;
      let thumb=null;if(typeof raw.thumb==='string'&&raw.thumb.startsWith('data:image/'))try{thumb=await (await fetch(raw.thumb)).blob();}catch{}
      await save({id:uuid(),url,title:String(raw.title||defaultTitle(url)).slice(0,160),albumIds:await idsFor(raw),notes:String(raw.notes||''),thumb,createdAt:Number(raw.createdAt)||Date.now()});added++;
    }
    if(Array.isArray(data.localVideos)){
      localVideos=await getAllLocal();
      for(const raw of data.localVideos){
        if(!raw||!raw.name)continue;if(localVideos.some(v=>v.name===raw.name&&v.size===Number(raw.size)))continue;
        await saveLocal({id:uuid(),name:String(raw.name).slice(0,200),fileName:String(raw.fileName||raw.name).slice(0,255),size:Number(raw.size)||0,type:String(raw.type||'video/*'),hasFile:false,dur:Number(raw.dur)||null,albumIds:await idsFor(raw),notes:String(raw.notes||''),createdAt:Number(raw.createdAt)||Date.now()});localAdded++;
      }
    }
    $('moreDialog').close();await refresh();alert(`匯入完成：新增 ${added} 筆 X 收藏、${localAdded} 筆本機影片（本機影片需重新選取檔案才能播放）。`);
  }catch(err){alert('無法匯入：請選擇本網站匯出的有效 JSON 備份檔。');console.error(err);}
  e.target.value='';
});

/* ================= install + init ================= */
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;$('installBtn').classList.remove('hidden');});
$('installBtn').addEventListener('click',async()=>{if(!deferredInstallPrompt){alert('在 iPhone 上請用 Safari 開啟網站，點分享按鈕，再選「加入主畫面」。');return;}deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('installBtn').classList.add('hidden');});
/* auto-update: check for a new version whenever the app comes back to the foreground, and reload once when one is installed */
function setupAutoUpdate(){
  if(!('serviceWorker'in navigator))return;
  const hadController=!!navigator.serviceWorker.controller;let reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!hadController||reloading)return;reloading=true;location.reload();});
  navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>{
    const check=()=>reg.update().catch(()=>{});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')check();});
    window.addEventListener('focus',check);window.addEventListener('online',check);
    setInterval(check,30*60*1000);
  }).catch(console.warn);
}
(async()=>{try{setupAutoUpdate();db=await openDB();await refresh();}catch(e){console.error(e);$('homeView').innerHTML='<p class="error">瀏覽器無法啟用本機資料庫，請使用最新版本 Safari 或 Chrome，並透過 HTTPS 開啟。</p>';}})();
