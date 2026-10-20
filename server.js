// Paleisk: node server.js  ->  http://localhost:3000   (reikia Node 18+, jokių paketų diegti nereikia)
const http=require("http"),fs=require("fs"),path=require("path");
const PORT=process.env.PORT||3000, DZ=process.env.DZ_BASE||"https://api.deezer.com";
// Numatyti atlikėjai. Daugiau galima pridėti pačiame puslapyje.
const ARTISTS=["OG Version","Jazzu","Andrius Mamontovas","Monika Liu","Justinas Jarutis","Jessica Shy","Vaidas Baumila","G&G Sindikatas","Lemon Joy","Foje","Mia","Leon Somov"];
const norm=x=>(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Deezer leidžia ~50 užklausų per 5 s, todėl jas siunčiame po vieną
let chain=Promise.resolve();
async function raw(p){for(let i=0;i<3;i++){let j;try{j=await(await fetch(DZ+p)).json()}catch(e){return{}}if(j.error&&j.error.code===4){await sleep(2500);continue}return j}return{}}
// prio=true: svarbi užklausa (dabartinė daina, paieška) – nelaukia fono eilėje
function dz(p,prio){if(prio)return raw(p);const r=chain.then(async()=>{await sleep(120);return raw(p)});chain=r.catch(()=>{});return r}
process.on("unhandledRejection",e=>console.log("Klaida:",e&&e.message));
const cache=new Map();
const HTMLS=new Map();
async function cached(k,fn,ttl){const c=cache.get(k);if(c&&Date.now()-c.t<ttl)return c.v;const v=await fn();if(v!=null&&!(Array.isArray(v)&&!v.length))cache.set(k,{t:Date.now(),v});return v}
const findArtist=n=>cached("a:"+norm(n),async()=>{
  const l=((await dz("/search/artist?limit=5&q="+encodeURIComponent(n),true)).data)||[];
  const ex=l.filter(a=>norm(a.name)===norm(n));
  const a=(ex.length?ex:l).sort((x,y)=>(y.nb_fan||0)-(x.nb_fan||0))[0];
  return a?{id:a.id,name:a.name}:null;
},864e5);
// Dainos tik iš pasirinkto atlikėjo: greitas sąrašas iškart, pilnas (visi albumai) kraunamas fone
async function build(a,deep){
  const P=!deep; // greitos užklausos eina be eilės
  const top=await dz(`/artist/${a.id}/top?limit=100`,P);
  const se=await dz("/search?limit=100&q="+encodeURIComponent(`artist:"${a.name}"`),P);
  const ab=[];let se2={};
  if(deep){
    se2=await dz("/search?limit=100&index=100&q="+encodeURIComponent(`artist:"${a.name}"`));
    const albs=((await dz(`/artist/${a.id}/albums?limit=100`)).data)||[];
    for(const al of albs){const t=((await dz(`/album/${al.id}/tracks?limit=100`)).data)||[];
      for(const x of t)ab.push({...x,album:{id:al.id,title:al.title,cover_medium:al.cover_medium,cover_big:al.cover_big}});}
  }
  const seen=new Set(),out=[];
  [...ab,...(top.data||[]),...(se.data||[]),...(se2.data||[])].forEach(x=>{
    if(!x.artist||x.artist.id!==a.id)return;
    const title=x.title_short||x.title,k=norm(title);if(seen.has(k))return;seen.add(k);
    out.push({id:x.id,title,artist:a.name,cover:x.album&&(x.album.cover_medium||x.album.cover),coverBig:x.album&&(x.album.cover_big||x.album.cover_xl),album:x.album&&x.album.title,albumId:x.album&&x.album.id});
  });
  return out;
}
const crawling=new Set();
function crawl(a,name){
  if(crawling.has(a.id))return;crawling.add(a.id);
  build(a,true).then(out=>{if(out.length){cache.set("t:"+norm(name),{t:Date.now(),v:out});pmemo.clear()}}).catch(()=>{}).finally(()=>crawling.delete(a.id));
}
const liveTracks=name=>cached("t:"+norm(name),async()=>{
  const a=await findArtist(name);if(!a)return[];
  const out=await build(a,false);crawl(a,name);return out;
},36e5);
const deepTracks=async name=>{const a=await findArtist(name);return a?build(a,true):[]};
// songs.json: iš anksto surinktos dainos (paleisk "node server.js --build" savo kompiuteryje) – svetainė startuoja iškart
let SNAP={};try{const j=JSON.parse(fs.readFileSync(path.join(__dirname,"songs.json"),"utf8"));for(const k in j)SNAP[norm(k)]=j[k];console.log("Įkelta iš songs.json:",Object.keys(SNAP).length,"atlikėjų")}catch(e){}
const tracksOf=name=>SNAP[norm(name)]?Promise.resolve(SNAP[norm(name)]):liveTracks(name);
const pmemo=new Map();
const pool=async names=>{const k=names.join("|"),c=pmemo.get(k);if(c&&Date.now()-c.t<60000)return c.v;
  const v=(await Promise.all(names.map(tracksOf))).flat().sort((a,b)=>a.id-b.id);if(pmemo.size>40)pmemo.clear();pmemo.set(k,{t:Date.now(),v});return v};
function seeded(str){let s=0;for(const c of str)s=(s*31+c.charCodeAt(0))>>>0;return()=>(s=(s*1664525+1013904223)>>>0)/4294967296}
const mkOpts=(p,ans,names)=>{const pl=[...new Set([...p.map(x=>x.artist),...names])].filter(n=>norm(n)!==norm(ans));const o=[];
  while(o.length<3&&pl.length)o.push(pl.splice(Math.random()*pl.length|0,1)[0]);o.push(ans);return o.sort(()=>Math.random()-.5)};
async function round(names,daily,cover,id,album,yr,opts){
  if(opts&&new Set(names).size<4)throw new Error("Reikia bent 4 atlikėjų");
  let p=await pool(daily?ARTISTS:names);
  if(cover){p=p.filter(t=>t.albumId&&t.album&&t.cover);if(!p.length)throw new Error("Nepavyko rasti albumų");
    const t=(album&&p.find(x=>String(x.albumId)===album))||p[Math.floor(Math.random()*p.length)];return{id:t.id,title:t.title,artist:t.artist,album:t.album,albumId:t.albumId,cover:t.cover,coverBig:t.coverBig||t.cover};}
  if(!p.length)throw new Error("Nepavyko rasti dainų");
  const day=new Date().toLocaleDateString("sv",{timeZone:"Europe/Vilnius"});
  const rnd=daily?seeded(day):Math.random;
  let i=id?Math.max(0,p.findIndex(x=>String(x.id)===id)):Math.floor(rnd()*p.length);
  for(let k=0;k<10;k++,i=(i+1)%p.length){
    const f=await dz("/track/"+p[i].id,true); // šviežia peržiūros nuoroda (jos greitai nebegalioja)
    if(f.preview&&(!yr||+(f.release_date||"").slice(0,4)>1900))return{opts:opts?mkOpts(p,p[i].artist,names):undefined,year:+(f.release_date||"").slice(0,4)||0,id:f.id,title:f.title_short||f.title,artist:p[i].artist,cover:f.album&&(f.album.cover_medium||f.album.cover),coverBig:f.album&&(f.album.cover_big||f.album.cover_xl),album:f.album&&f.album.title,albumId:f.album&&f.album.id,preview:f.preview,start:rnd()*14};
  }
  throw new Error("Nepavyko rasti dainos");
}
async function search(q,names,album){
  const v=norm(q);if(v.length<2)return[];
  if(album){const seen=new Set(),out=[];
    for(const t of await pool(names)){if(!t.albumId||seen.has(t.albumId))continue;
      if(norm(t.album+" "+t.artist).includes(v)){seen.add(t.albumId);out.push({id:t.albumId,title:t.album,artist:t.artist,cover:t.cover});if(out.length>=8)break}}
    return out;}
  return(await pool(names)).filter(t=>norm(t.title+" "+t.artist).includes(v)).slice(0,8);
}
// ---- lyderių lentelė (nuolatinė, jei nustatytas Upstash Redis; kitaip tik atmintyje) ----
const LF=process.env.HL_SOURCE==="lastfm"?(process.env.LASTFM_API_KEY||""):"",LM=process.env.LASTFM_METRIC==="listeners"?"listeners":"playcount";
const day=()=>new Date().toLocaleDateString("sv",{timeZone:"Europe/Vilnius"});
const UP=process.env.UPSTASH_REDIS_REST_URL,UT=process.env.UPSTASH_REDIS_REST_TOKEN,mem={},hits=new Map();
const rc=async a=>(await(await fetch(UP,{method:"POST",headers:{Authorization:"Bearer "+UT},body:JSON.stringify(a)})).json()).result;
async function lbAdd(n,p){p=p*(cfg.mult||1);for(const k of["lb:all","lb:"+day()]){if(UP){await rc(["ZINCRBY",k,p,n]);if(k!=="lb:all")await rc(["EXPIRE",k,172800])}else{mem[k]=mem[k]||{};mem[k][n]=(mem[k][n]||0)+p}}}
async function lbTop(k,n=10){if(UP){const r=await rc(["ZREVRANGE",k,0,n-1,"WITHSCORES"]),o=[];for(let i=0;i<r.length;i+=2)o.push({n:r[i],p:+r[i+1]});return o}
  return Object.entries(mem[k]||{}).map(([n,p])=>({n,p})).sort((a,b)=>b.p-a.p).slice(0,n)}
async function lbSet(n,p){if(UP)await rc(["ZADD","lb:all","GT",p,n]);else{mem["lb:all"]=mem["lb:all"]||{};mem["lb:all"][n]=Math.max(mem["lb:all"][n]||0,p)}}
async function lbDel(n){for(const k of["lb:all","lb:"+day()]){if(UP)await rc(["ZREM",k,n]);else if(mem[k])delete mem[k][n]}}
// draudžiami žodžiai: Render Environment kintamasis BANNED_WORDS (atskirti kableliais)
const BAD=(process.env.BANNED_WORDS||"").split(",").map(x=>x.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"")).filter(Boolean);
const isBad=n=>{const t=n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");return BAD.concat(banned.map(normW)).filter(Boolean).some(w=>t.includes(w))};

const own={};let banned=[];let cfg={mult:1,banner:""};
async function saveCfg(){if(UP)await rc(["HSET","cfg","mult",String(cfg.mult),"banner",cfg.banner||" "])}
async function loadCfg(){if(UP){try{const r=await rc(["HGETALL","cfg"])||[];for(let i=0;i<r.length;i+=2){if(r[i]==="mult")cfg.mult=+r[i+1]||1;if(r[i]==="banner")cfg.banner=String(r[i+1]).trim()}}catch(e){}}}
async function ownGet(n){return UP?await rc(["HGET","owners",n]):own[n]}
async function ownSet(n,t){if(UP)await rc(["HSET","owners",n,t]);else own[n]=t}
async function ownDel(n){if(UP)await rc(["HDEL","owners",n]);else delete own[n]}
async function claim(n,t){const o=await ownGet(n);if(o==null||o===""){await ownSet(n,t||"");return true}return o===(t||"")}
async function lbScore(k,n){if(UP){const r=await rc(["ZSCORE",k,n]);return r==null?0:+r}return(mem[k]||{})[n]||0}
async function lbPut(k,n,p){if(UP)await rc(["ZADD",k,p,n]);else{mem[k]=mem[k]||{};mem[k][n]=p}}
async function lbRem(k,n){if(UP)await rc(["ZREM",k,n]);else if(mem[k])delete mem[k][n]}
async function lbRename(a,b){for(const k of["lb:all","lb:"+day()]){const s=await lbScore(k,a);if(s>0){await lbRem(k,a);await lbPut(k,b,(await lbScore(k,b))+s)}}}
async function lbClear(k){if(UP)await rc(["DEL",k]);else delete mem[k]}
async function loadBans(){if(UP){try{banned=(await rc(["SMEMBERS","ban"]))||[]}catch(e){}}}
const normW=x=>String(x).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
const readJ=async r=>{let b="";for await(const c of r){b+=c;if(b.length>2000)break}try{return JSON.parse(b)}catch(e){return{}}};
const originOf=req=>{let h=req.headers["x-forwarded-host"]||req.headers.host||"";if(!/^[a-z0-9.-]+(:\d+)?$/i.test(h))h="atspekdaina.eu";return(/^(localhost|127\.)/.test(h)?"http://":"https://")+h};
// ---- multiplayer kambariai (atmintyje) ----
const rooms=new Map(),uid=()=>Math.random().toString(36).slice(2,8);
async function mpRound(r){
  let f={},id;
  while(r.i<r.ids.length){id=r.ids[r.i];f=await dz("/track/"+id,true);if(f.preview)break;r.i++}
  if(r.i>=r.ids.length){r.phase="final";return false}
  r.cur={id,title:f.title_short||f.title||"?",artist:(f.artist&&f.artist.name)||"",album:f.album&&f.album.title,cover:f.album&&(f.album.cover_big||f.album.cover_medium),preview:f.preview,start:Math.random()*14,t0:Date.now()+3000};
  r.phase="play";r.votes=new Set();for(const p of Object.values(r.players))p.ans=0;return true;
}
async function mpState(r,pid){
  const now=Date.now(),P=Object.values(r.players);
  const skip=r.votes&&r.votes.size*2>P.length;
  if(r.phase==="play"&&(now>r.cur.t0+25000||P.every(p=>p.ans)||skip)){r.phase="reveal";r.rt=now;r.fast=skip||P.every(p=>p.ans===2)}
  else if(r.phase==="reveal"&&now>r.rt+(r.fast?3500:6000)&&!r.busy){r.busy=1;try{if(++r.i>=r.ids.length)r.phase="final";else await mpRound(r)}finally{r.busy=0}}
  const c=r.cur,rev=r.phase==="reveal"&&c,live=c&&(r.phase==="play"||rev);
  return{limit:25,votes:r.votes?r.votes.size:0,ph:r.phase,i:r.i,n:r.ids.length,secs:r.secs,one:r.one,now,host:r.host===pid,code:r.code,names:r.names,
    pl:P.map(p=>({n:p.name,s:p.score,d:!!p.ans})).sort((a,b)=>b.s-a.s),
    cur:live?{preview:c.preview,start:c.start,t0:c.t0,...(rev?{title:c.title,artist:c.artist,album:c.album,cover:c.cover}:{})}:null};
}
const VER="v12";
const ap=n=>[path.join(__dirname,"public",n),path.join(__dirname,n)].find(p=>fs.existsSync(p))||path.join(__dirname,"public",n);
let YT={};try{YT=JSON.parse(fs.readFileSync(ap("youtube.json"),"utf8"))}catch(e){}
// ---- YouTube peržiūros bet kuriam atlikėjui (kai pirmą kartą pasirenkamas „Daugiau / Mažiau“) ----
const YKEY=process.env.YOUTUBE_API_KEY||"",ytDone=new Set();let ytQuota={d:"",n:0};
async function ytPersist(map){if(UP&&Object.keys(map).length){const a=["HSET","yt"];for(const k in map)a.push(k,String(map[k]));await rc(a)}}
async function loadYT(){if(!UP)return;try{const r=await rc(["HGETALL","yt"])||[];for(let i=0;i<r.length;i+=2)if(!YT[r[i]])YT[r[i]]=+r[i+1];(await rc(["SMEMBERS","ytdone"])||[]).forEach(x=>ytDone.add(x))}catch(e){}}
async function ytLookup(artist,tracks){
  const key=norm(artist);if(!YKEY||ytDone.has(key))return;
  const d=day();if(ytQuota.d!==d)ytQuota={d,n:0};if(ytQuota.n>=75)return;ytQuota.n++;ytDone.add(key);
  if(UP)try{await rc(["SADD","ytdone",key])}catch(e){}
  const yget=async(p,pr)=>{const u=new URL((process.env.YT_BASE||"https://www.googleapis.com/youtube/v3/")+p);for(const k in pr)u.searchParams.set(k,pr[k]);u.searchParams.set("key",YKEY);return(await fetch(u)).json()};
  const clean=x=>norm(String(x).replace(/\(.*?\)|\[.*?\]|official.*|music video.*|lyric.*/ig,""));
  try{
    const s=await yget("search",{part:"snippet",q:artist,type:"channel",maxResults:1});const ch=s.items&&s.items[0];if(!ch)return;
    const ct=norm((ch.snippet&&ch.snippet.title)||"");if(!(ct&&(ct.includes(key)||key.includes(ct))))return; // kanalo pavadinimas turi atitikti atlikėją
    const cid=(ch.id&&ch.id.channelId)||ch.snippet.channelId;
    const c=await yget("channels",{part:"contentDetails",id:cid});const up=c.items&&c.items[0]&&c.items[0].contentDetails.relatedPlaylists.uploads;if(!up)return;
    const vids=[];let tok="";
    for(let i=0;i<10;i++){const pi=await yget("playlistItems",{part:"snippet",playlistId:up,maxResults:50,...(tok?{pageToken:tok}:{})});
      (pi.items||[]).forEach(x=>vids.push({id:x.snippet.resourceId.videoId,t:x.snippet.title,v:0}));tok=pi.nextPageToken;if(!tok)break}
    for(let i=0;i<vids.length;i+=50){const vs=await yget("videos",{part:"statistics",id:vids.slice(i,i+50).map(x=>x.id).join(",")});
      (vs.items||[]).forEach(it=>{const x=vids.find(y=>y.id===it.id);if(x)x.v=+it.statistics.viewCount||0})}
    const out={};
    for(const tr of tracks){const tn=clean(tr.title);if(tn.length<3)continue;let best=0;
      for(const x of vids){const vn=" "+clean(x.t).replace(key," ").replace(/\s+/g," ").trim()+" ";if(x.v&&vn.includes(" "+tn+" "))best=Math.max(best,x.v)}
      if(best)out[tr.id]=best}
    Object.assign(YT,out);await ytPersist(out);
  }catch(e){}
}
const send=(res,code,obj)=>{res.writeHead(code,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(obj))};
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://x"),q=u.searchParams,n=(q.get("a")||"").split("|").filter(Boolean),names=n.length?n:ARTISTS;
  try{
    if(u.pathname==="/api/artists")return send(res,200,ARTISTS);
    if(u.pathname==="/api/artist"){const a=await findArtist(q.get("name")||"");return a?send(res,200,a):send(res,404,{error:"Atlikėjas nerastas"})}
    if(u.pathname==="/api/artistsearch"){const l=((await dz("/search/artist?limit=6&q="+encodeURIComponent(q.get("q")||""),true)).data)||[];return send(res,200,l.map(a=>({id:a.id,name:a.name,picture:a.picture_small})))}
    if(u.pathname==="/api/stats"){const o={};for(const n of ARTISTS)o[n]=(await tracksOf(n)).length;return send(res,200,o)}
    if(u.pathname==="/robots.txt"){res.writeHead(200,{"Content-Type":"text/plain"});return res.end("User-agent: *\nAllow: /\nSitemap: "+originOf(req)+"/sitemap.xml\n")}
    if(u.pathname==="/sitemap.xml"){res.writeHead(200,{"Content-Type":"application/xml"});return res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>'+originOf(req)+'/</loc></url></urlset>')}
    if(u.pathname==="/api/leaderboard")return send(res,200,await lbTop(q.get("w")==="all"?"lb:all":"lb:"+day()));
    if(u.pathname==="/api/score"&&req.method==="POST"){
      const ip=(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0],t=Date.now(),h=(hits.get(ip)||[]).filter(x=>t-x<6e4);
      if(h.length>=40)return send(res,429,{error:"Per daug"});h.push(t);hits.set(ip,h);
      const j=await readJ(req),n=String(j.n||"").replace(/[<>&"]/g,"").trim().slice(0,16),p=Math.round(+j.p);
      if(n.length<2||isBad(n))return send(res,400,{error:"Netinka"});
      if(!(await claim(n,String(j.t||"").slice(0,40))))return send(res,403,{error:"Vardas užimtas"});
      if(j.sync){await lbSet(n,Math.min(100000,Math.max(0,p)));return send(res,200,{ok:1})}
      if(!(p>=1&&p<=5))return send(res,400,{error:"Netinka"});await lbAdd(n,p);return send(res,200,{ok:1});
    }
    if(u.pathname==="/api/rename"&&req.method==="POST"){
      const j=await readJ(req),t=String(j.t||"").slice(0,40),f=String(j.from||"").trim().slice(0,16),n2=String(j.to||"").replace(/[<>&"]/g,"").trim().slice(0,16);
      if(n2.length<2||isBad(n2))return send(res,400,{error:"Netinka"});
      const of=await ownGet(f);if(of!=null&&of!==""&&of!==t)return send(res,403,{error:"Ne tavo vardas"});
      const on2=await ownGet(n2);if(on2!=null&&on2!==""&&on2!==t)return send(res,409,{error:"Vardas užimtas"});
      await lbRename(f,n2);await ownSet(n2,t);if(f!==n2)await ownDel(f);return send(res,200,{ok:1});
    }
    if(u.pathname==="/admin"){try{res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});return res.end(fs.readFileSync(ap("admin.html")))}catch(e){return send(res,404,{error:"Nerasta"})}}
    if(u.pathname==="/api/admin"&&req.method==="POST"){
      const j=await readJ(req);
      if(!process.env.ADMIN_KEY)return send(res,403,{error:"Serveryje nenustatytas ADMIN_KEY (Render Environment)"});
      if(j.key!==process.env.ADMIN_KEY)return send(res,403,{error:"Neteisingas raktas"});
      const cl=x=>String(x||"").replace(/[<>&"]/g,"").trim().slice(0,16),dk="lb:"+day();
      if(j.del){await lbDel(String(j.del));await ownDel(String(j.del))}
      if(j.rename&&j.rename.from&&cl(j.rename.to).length>=2){const f=String(j.rename.from),b=cl(j.rename.to),o=await ownGet(f);await lbRename(f,b);await ownDel(f);if(o!=null)await ownSet(b,o)}
      if(j.set&&j.set.n)await lbPut(j.set.day?dk:"lb:all",String(j.set.n),Math.max(0,Math.round(+j.set.p||0)));
      if(j.delta&&j.delta.n){const n=String(j.delta.n),d=Math.round(+j.delta.p||0);await lbPut("lb:all",n,Math.max(0,(await lbScore("lb:all",n))+d));if(j.delta.day)await lbPut(dk,n,Math.max(0,(await lbScore(dk,n))+d))}
      if(j.addp&&cl(j.addp.n).length>=2){const n=cl(j.addp.n);await lbPut("lb:all",n,(await lbScore("lb:all",n))+Math.max(0,Math.round(+j.addp.p||0)))}
      if(j.zero){await lbPut("lb:all",String(j.zero),0);await lbRem(dk,String(j.zero))}
      if(j.free)await ownDel(String(j.free));
      if(j.banplayer){const n=String(j.banplayer);await lbDel(n);await ownDel(n);const w=n.toLowerCase().slice(0,30);if(w&&!banned.includes(w)){banned.push(w);if(UP)await rc(["SADD","ban",w])}}
      if(j.clear==="day")await lbClear(dk);
      if(j.clear==="all")await lbClear("lb:all");
      if(j.ban){const w=String(j.ban).trim().toLowerCase().slice(0,30);if(w&&!banned.includes(w)){banned.push(w);if(UP)await rc(["SADD","ban",w])}}
      if(j.unban){banned=banned.filter(x=>x!==j.unban);if(UP)await rc(["SREM","ban",String(j.unban)])}
      if(j.mult!=null){cfg.mult=Math.max(1,Math.min(10,Math.round(+j.mult)||1));await saveCfg()}
      if(j.banner!=null){cfg.banner=String(j.banner).slice(0,160).trim();await saveCfg()}
      if(j.closeRoom)rooms.delete(String(j.closeRoom).toUpperCase());
      const all=await lbTop("lb:all",1000);
      return send(res,200,{all:all.slice(0,200),day:await lbTop(dk,200),banned,cfg,saugykla:UP?"Upstash (nuolatinė)":"atmintis (išsivalo)",
        stats:{zaidejai:all.length,taskai:all.reduce((a,x)=>a+x.p,0)},rooms:[...rooms.values()].map(r=>({code:r.code,players:Object.keys(r.players).length,phase:r.phase}))});
    }
    if(u.pathname==="/api/mp"&&req.method==="POST"){
      const j=await readJ(req),a=j.a,nm=s=>String(s||"").trim().slice(0,16)||"Žaidėjas";
      for(const[k,x]of rooms)if(Date.now()-x.made>72e5)rooms.delete(k);
      if(a==="create"){
        const nn=(j.names||[]).slice(0,30),p=await pool(nn.length?nn:ARTISTS),ids=p.map(x=>x.id).sort(()=>Math.random()-.5).slice(0,Math.min(20,+j.rounds||10));
        if(!ids.length)return send(res,200,{err:"Nepavyko rasti dainų"});
        const code=uid().slice(0,4).toUpperCase(),pid=uid();
        rooms.set(code,{code,host:pid,names:nn.length?nn:ARTISTS,ids,i:0,secs:Math.max(1,Math.min(15,+j.secs||5)),one:!!j.one,phase:"lobby",players:{[pid]:{name:nm(j.name),score:0,ans:0}},made:Date.now()});
        return send(res,200,{code,pid,names:nn});
      }
      const r=rooms.get(String(j.code||"").toUpperCase());if(!r)return send(res,200,{err:"Kambarys nerastas"});
      if(a==="join"){if(r.phase!=="lobby")return send(res,200,{err:"Žaidimas jau prasidėjo"});if(Object.keys(r.players).length>=12)return send(res,200,{err:"Kambarys pilnas"});
        const pid=uid();r.players[pid]={name:nm(j.name),score:0,ans:0};return send(res,200,{code:r.code,pid,names:r.names})}
      if(a==="start"){if(r.host===j.pid&&r.phase==="lobby"&&!(await mpRound(r))){r.phase="lobby";return send(res,200,{err:"Nepavyko užkrauti dainų"})}return send(res,200,{ok:1})}
      if(a==="guess"){const p=r.players[j.pid];if(!p||r.phase!=="play"||Date.now()<r.cur.t0||p.ans)return send(res,200,{ok:0});
        const ok=String(j.tid)===String(r.cur.id)||(norm(j.title)===norm(r.cur.title)&&norm(j.artist)===norm(r.cur.artist));
        if(ok){p.ans=2;p.score+=Math.max(10,100-Math.floor((Date.now()-r.cur.t0)/1000)*4)}else{p.score=Math.max(0,p.score-10);if(r.one)p.ans=1}
        return send(res,200,{ok:ok?1:0,locked:!ok&&r.one?1:0})}
      if(a==="vote"){if(r.phase==="play"&&r.players[j.pid]&&r.votes)r.votes.add(j.pid);return send(res,200,{ok:1})}
      if(a==="leave"){delete r.players[j.pid];const ids=Object.keys(r.players);if(!ids.length)rooms.delete(r.code);else if(r.host===j.pid)r.host=ids[0];return send(res,200,{ok:1})}
      return send(res,200,await mpState(r,j.pid));
    }
    if(u.pathname==="/api/hl"){
      const ex=q.get("ex"),c=(await pool(names)).filter(x=>String(x.id)!==ex);let t,f;
      const want=q.get("m")||"",needLF=want.startsWith("Last.fm"),needYT=want.startsWith("YouTube");
      if(YKEY&&!want){for(const a of [...new Set(c.map(x=>x.artist))]){if(!c.some(x=>x.artist===a&&YT[x.id])&&!ytDone.has(norm(a))){await ytLookup(a,await tracksOf(a));break}}}
      if(!want||needYT){const cc=c.filter(x=>YT[x.id]);
        if(cc.length>=(needYT?1:2)){const t0=cc[Math.random()*cc.length|0];return send(res,200,{id:t0.id,title:t0.title,artist:t0.artist,cover:t0.coverBig||t0.cover,rank:YT[t0.id],metric:"YouTube peržiūrų skaičius"})}
        if(needYT)return send(res,500,{error:"YouTube duomenų nerasta"})}
      if(LF&&c.length&&(!want||needLF))for(let k=0;k<14;k++){
        t=c[Math.random()*c.length|0];
        try{const r=await(await fetch(`https://ws.audioscrobbler.com/2.0/?method=track.getInfo&autocorrect=1&format=json&api_key=${LF}&artist=${encodeURIComponent(t.artist)}&track=${encodeURIComponent(t.title)}`)).json();
          const L=+(r.track&&r.track[LM]);
          if(L>0)return send(res,200,{id:t.id,title:t.title,artist:t.artist,cover:t.coverBig||t.cover,rank:L,metric:LM==="playcount"?"Last.fm paleidimų skaičius (viso laiko)":"Last.fm klausytojų skaičius (viso laiko)"});}catch(e){}
      }
      if(needLF)return send(res,500,{error:"Last.fm duomenų nerasta"});
      for(let k=0;k<6&&c.length;k++){t=c[Math.random()*c.length|0];f=await dz("/track/"+t.id,true);if(f&&f.rank)break}
      if(!f||!f.rank)return send(res,500,{error:"Nepavyko"});
      return send(res,200,{id:f.id,title:f.title_short||f.title,artist:t.artist,cover:f.album&&(f.album.cover_big||f.album.cover_medium),rank:f.rank,metric:"Deezer populiarumo balas"});
    }
    if(u.pathname==="/api/version"){let iv=null;try{iv=(fs.readFileSync(ap("index.html"),"utf8").match(/app-version" content="([^"]+)"/)||[])[1]||null}catch(e){}
      return send(res,200,{server:VER,index:iv,admin:fs.existsSync(ap("admin.html")),saugykla:UP?"Upstash (nuolatinė)":"atmintis (išsivalo)",lastfm:!!LF,youtube:Object.keys(YT).length,youtubeRaktas:!!process.env.YOUTUBE_API_KEY})}
    if(u.pathname==="/api/me"){const n=String(q.get("n")||"").slice(0,16);let sc=0;
      if(UP){const r=await rc(["ZSCORE","lb:all",n]);sc=r==null?0:+r}else sc=(mem["lb:all"]||{})[n]||0;return send(res,200,{p:sc})}
    if(u.pathname==="/api/banner")return send(res,200,{banner:cfg.banner,mult:cfg.mult});
    if(u.pathname==="/api/pool"){const p=await pool(names);return send(res,200,{t:p.map(x=>x.id),a:[...new Set(p.filter(x=>x.albumId).map(x=>x.albumId))]})}
    if(u.pathname==="/api/round")return send(res,200,await round(names,q.get("daily")==="1",q.get("mode")==="cover",q.get("id"),q.get("album"),q.get("year")==="1",q.get("opts")==="1"));
    if(u.pathname==="/api/search")return send(res,200,await search(q.get("q")||"",q.get("daily")==="1"?ARTISTS:names,q.get("album")==="1"));
    const ST={"/og.png":"image/png","/favicon.png":"image/png","/favicon.ico":"image/x-icon","/apple-touch-icon.png":"image/png"};
    if(ST[u.pathname]){try{const d=fs.readFileSync(ap(u.pathname.slice(1)));res.writeHead(200,{"Content-Type":ST[u.pathname],"Cache-Control":"public, max-age=86400"});return res.end(d)}catch(e){return send(res,404,{error:"Nerasta"})}}
    // puslapio adresas įrašomas į nuorodų peržiūros (og:) žymas pagal tai, kuriuo adresu atidaryta svetainė
    let host=req.headers["x-forwarded-host"]||req.headers.host||"";if(!/^[a-z0-9.-]+(:\d+)?$/i.test(host))host="atspekdaina.eu";
    const origin=(/^(localhost|127\.)/.test(host)?"http://":"https://")+host;
    let H=HTMLS.get(origin);
    if(!H){try{const raw=Buffer.from(fs.readFileSync(ap("index.html"),"utf8").split("__ORIGIN__").join(origin));H={raw,gz:require("zlib").gzipSync(raw)};if(HTMLS.size>20)HTMLS.clear();HTMLS.set(origin,H)}catch(e){return send(res,404,{error:"Nerasta"})}}
    const gz=/gzip/.test(req.headers["accept-encoding"]||"");
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache",...(gz?{"Content-Encoding":"gzip"}:{})});res.end(gz?H.gz:H.raw);
  }catch(e){send(res,500,{error:e.message})}
});
if(process.argv.includes("--build")||process.argv.includes("--youtube")){(async()=>{const o={};if(process.argv.includes("--youtube")){Object.assign(o,JSON.parse(fs.readFileSync(ap("songs.json"),"utf8")))}else for(const n of ARTISTS){o[n]=await deepTracks(n);console.log(n+":",o[n].length)}
  if(!process.argv.includes("--youtube")){fs.writeFileSync(path.join(__dirname,"songs.json"),JSON.stringify(o));console.log("Išsaugota songs.json");}
    const YK=process.env.YOUTUBE_API_KEY;
    if(YK){
      const yget=async(p,pr)=>{const u=new URL("https://www.googleapis.com/youtube/v3/"+p);for(const k in pr)u.searchParams.set(k,pr[k]);u.searchParams.set("key",YK);return(await fetch(u)).json()};
      const clean=x=>norm(String(x).replace(/\(.*?\)|\[.*?\]|official.*|music video.*|lyric.*/ig,""));
      const yt={};
      for(const n of ARTISTS){
        if(!o[n])continue;try{
          const s=await yget("search",{part:"snippet",q:n,type:"channel",maxResults:1});const ch=s.items&&s.items[0];if(!ch){console.log("YouTube: nerastas kanalas",n);continue}
          const cid=(ch.id&&ch.id.channelId)||ch.snippet.channelId;
          const c=await yget("channels",{part:"contentDetails,snippet",id:cid});const up=c.items&&c.items[0]&&c.items[0].contentDetails.relatedPlaylists.uploads;if(!up)continue;
          const vids=[];let tok="";
          for(let i=0;i<10;i++){const pi=await yget("playlistItems",{part:"snippet",playlistId:up,maxResults:50,...(tok?{pageToken:tok}:{})});
            (pi.items||[]).forEach(x=>vids.push({id:x.snippet.resourceId.videoId,t:x.snippet.title,v:0}));tok=pi.nextPageToken;if(!tok)break}
          for(let i=0;i<vids.length;i+=50){const vs=await yget("videos",{part:"statistics",id:vids.slice(i,i+50).map(x=>x.id).join(",")});
            (vs.items||[]).forEach(it=>{const x=vids.find(y=>y.id===it.id);if(x)x.v=+it.statistics.viewCount||0})}
          const an=norm(n);let cnt=0;
          for(const tr of o[n]){const tn=clean(tr.title);if(tn.length<3)continue;let best=0;
            for(const x of vids){const vn=" "+clean(x.t).replace(an," ").replace(/\s+/g," ").trim()+" ";if(x.v&&vn.includes(" "+tn+" "))best=Math.max(best,x.v)}
            if(best){yt[tr.id]=best;cnt++}}
          console.log("YouTube:",n,"("+((c.items[0].snippet||{}).title||"?")+")","- surasta peržiūrų dainoms:",cnt);
        }catch(e){console.log("YouTube klaida",n,e.message)}
      }
      fs.writeFileSync(path.join(__dirname,"youtube.json"),JSON.stringify(yt));console.log("Išsaugota youtube.json (dainų:",Object.keys(yt).length+")");
    }else console.log("YOUTUBE_API_KEY nenustatytas, youtube.json nesukurtas");
    process.exit(0)})();}
else server.listen(PORT,()=>{console.log("Atidaryk http://localhost:"+PORT);loadBans();loadCfg();loadYT();if(Object.keys(SNAP).length<ARTISTS.length)pool(ARTISTS).then(p=>console.log("Paruošta dainų:",p.length)).catch(()=>{})});
