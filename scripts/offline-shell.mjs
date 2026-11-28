import { createHash } from 'node:crypto';

export function buildCacheVersion(paths, htmlSources) {
  return createHash('sha256').update(JSON.stringify([paths, htmlSources])).digest('hex').slice(0, 12);
}

export function buildServiceWorker(paths, version) {
  return `const NAME=${JSON.stringify('relaytrace-shell-' + version)};
const ASSETS=${JSON.stringify(paths)};
self.addEventListener('install',e=>{e.waitUntil(caches.open(NAME).then(c=>c.addAll(ASSETS.map(path=>new Request(path,{cache:'reload'})))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('relaytrace-shell-')&&k!==NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);

  if(r.method!=='GET'||u.origin!==self.location.origin)return;
  if(r.mode==='navigate'){
    e.respondWith(fetch(r).catch(async()=>await caches.match('/index.html',{cacheName:NAME,ignoreVary:true})||Response.error()));return;
  }
  if(!ASSETS.includes(u.pathname))return;
  e.respondWith(caches.match(r,{cacheName:NAME,ignoreVary:true}).then(hit=>hit||fetch(r)));
});`;
}
