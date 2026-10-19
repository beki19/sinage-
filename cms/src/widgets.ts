/**
 * Self-contained HTML pages for the world clock and news feed items. The player shows them in a WebView,
 * loaded with the CMS address as the page origin, so the news page can fetch headlines from the CMS.
 * The player replaces __DEVICE_TOKEN__ with its own token before loading.
 */

/** JSON that is safe inside a <script> tag. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const page = (style: string, body: string, script: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden;font-family:system-ui,Roboto,"Segoe UI",sans-serif}${style}</style>
</head><body>${body}<script>${script}</script></body></html>`;

export interface ClockOptions {
  clocks: { label: string; tz: string }[];
  color: string;
  background: string;
  hour24: boolean;
}

export function clockHtml(o: ClockOptions): string {
  return page(
    `body{background:${o.background};color:${o.color}}
#c{height:100%;display:grid;box-sizing:border-box;padding:2vmin;align-content:center}
.k{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-width:0;overflow:hidden}
.t{font-weight:700;font-variant-numeric:tabular-nums;line-height:1.05;white-space:nowrap}
.l{opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.d{opacity:.65;white-space:nowrap}`,
    `<div id="c"></div>`,
    `const clocks=${scriptJson(o.clocks)},h24=${o.hour24};
const c=document.getElementById("c");
const cells=clocks.map(k=>{const e=document.createElement("div");e.className="k";
e.innerHTML='<div class="l"></div><div class="t"></div><div class="d"></div>';e.querySelector(".l").textContent=k.label;c.appendChild(e);return e;});
function layout(){const W=innerWidth,H=innerHeight,n=clocks.length;let best=0,cols=1;
for(let k=1;k<=n;k++){const r=Math.ceil(n/k),s=Math.min(W/k/(h24?3.4:4.6),H/r/2.4);if(s>best){best=s;cols=k;}}
c.style.gridTemplateColumns="repeat("+cols+",1fr)";
cells.forEach(e=>{e.querySelector(".t").style.fontSize=best+"px";e.querySelector(".l").style.fontSize=best*.38+"px";e.querySelector(".d").style.fontSize=best*.3+"px";});}
function tick(){const now=new Date();clocks.forEach((k,i)=>{const e=cells[i];
try{e.querySelector(".t").textContent=new Intl.DateTimeFormat(undefined,{timeZone:k.tz,hour:"2-digit",minute:"2-digit",hour12:!h24}).format(now);
e.querySelector(".d").textContent=new Intl.DateTimeFormat(undefined,{timeZone:k.tz,weekday:"short",day:"numeric",month:"short"}).format(now);}
catch(err){e.querySelector(".t").textContent="--:--";}});}
layout();tick();addEventListener("resize",layout);setInterval(tick,1000);`,
  );
}

export interface FeedOptions {
  itemId: string;
  mode: "ticker" | "list";
  title: string;
  color: string;
  background: string;
}

export function feedHtml(o: FeedOptions): string {
  return page(
    `body{background:${o.background};color:${o.color}}
#t{position:absolute;top:0;bottom:0;display:flex;align-items:center;white-space:nowrap;will-change:transform}
#t span.s{opacity:.6;margin:0 .9em}
#l{height:100%;box-sizing:border-box;padding:4vmin;display:flex;flex-direction:column}
#l h1{margin:0 0 .6em;font-size:1.1em;opacity:.75;text-transform:uppercase;letter-spacing:.08em}
#l ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.9em;flex:1;overflow:hidden}
#l li{line-height:1.25}#l small{display:block;opacity:.6;font-size:.7em;margin-top:.2em}
#e{opacity:.6;padding:4vmin}`,
    `<div id="root"></div>`,
    `const ID=${scriptJson(o.itemId)},MODE=${scriptJson(o.mode)},TITLE=${scriptJson(o.title)},KEY="feed:"+ID;
const root=document.getElementById("root");let items=[];try{items=JSON.parse(localStorage.getItem(KEY)||"[]")}catch(e){}
let anim=null,page=0,timer=null;
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
function render(){root.innerHTML="";if(anim)anim.cancel();clearInterval(timer);
if(!items.length){root.appendChild(el("div",null,"Loading headlines…")).id="e";return;}
if(MODE==="ticker"){const t=el("div");t.id="t";t.style.fontSize=innerHeight*.5+"px";
items.forEach((it,i)=>{if(i)t.appendChild(el("span","s","•"));t.appendChild(el("span",null,it.title));});
if(TITLE){t.insertBefore(el("span","s","•"),t.firstChild);t.insertBefore(el("strong",null,TITLE),t.firstChild);}
root.appendChild(t);const w=t.scrollWidth,W=innerWidth;
// A calm, broadcast-style pace: about 20 seconds to cross the zone.
anim=t.animate([{transform:"translateX("+W+"px)"},{transform:"translateX("+(-w)+"px)"}],{duration:(w+W)/Math.max(W/20,50)*1000,iterations:Infinity});return;}
const box=el("div");box.id="l";const size=Math.max(14,Math.min(innerWidth/22,innerHeight/9));box.style.fontSize=size+"px";
if(TITLE)box.appendChild(el("h1",null,TITLE));const ul=el("ul");box.appendChild(ul);root.appendChild(box);
// Fill the box with as many whole headlines as fit, then move on to the next ones.
function show(){ul.innerHTML="";if(page>=items.length)page=0;let n=0;
for(let i=page;i<items.length;i++){const it=items[i],li=el("li",null,it.title);if(it.source)li.appendChild(el("small",null,it.source));ul.appendChild(li);
if(ul.scrollHeight>ul.clientHeight+1&&n>0){li.remove();break;}n++;}page+=Math.max(n,1);}
show();timer=setInterval(show,10000);}
async function load(){try{const r=await fetch("/api/player/feed/"+encodeURIComponent(ID),{headers:{authorization:"Device __DEVICE_TOKEN__"}});
if(r.ok){const d=await r.json();if(d.items&&d.items.length){items=d.items;try{localStorage.setItem(KEY,JSON.stringify(items))}catch(e){}render();return;}}}catch(e){}
if(!items.length){root.innerHTML="";root.appendChild(el("div",null,"Headlines unavailable right now")).id="e";}}
render();load();setInterval(load,10*60*1000);addEventListener("resize",render);`,
  );
}

export interface XOptions {
  handle: string;
  color: string;
  background: string;
}

/** X's own embedded timeline for an account. X decides what logged-out viewers see, and may show nothing. */
export function xHtml(o: XOptions): string {
  const dark = parseInt(o.background.slice(1, 3), 16) + parseInt(o.background.slice(3, 5), 16) + parseInt(o.background.slice(5, 7), 16) < 384;
  return page(
    `body{background:${o.background};color:${o.color}}#w{height:100%;overflow:hidden}#w>a{display:none}
#f{position:absolute;inset:0;display:grid;place-content:center;text-align:center;font-size:5vmin;padding:4vmin;opacity:.8}`,
    `<div id="w"></div><div id="f">Loading posts from @${o.handle}…</div>`,
    `const w=document.getElementById("w"),f=document.getElementById("f");
function build(){const a=document.createElement("a");a.className="twitter-timeline";a.href="https://twitter.com/${o.handle}";
a.setAttribute("data-theme","${dark ? "dark" : "light"}");a.setAttribute("data-chrome","noheader nofooter noborders transparent");
a.setAttribute("data-height",String(innerHeight));a.setAttribute("data-dnt","true");a.textContent="Posts by @${o.handle}";
w.replaceChildren(a);if(window.twttr&&twttr.widgets)twttr.widgets.load(w);}
build();
const s=document.createElement("script");s.src="https://platform.twitter.com/widgets.js";s.async=true;document.body.appendChild(s);
// The embed adds its iframe straight away but only gives it a height once posts have loaded.
const seen=()=>{const fr=w.querySelector("iframe");if(fr&&fr.offsetHeight>50){f.style.display="none";return true}return false};
const iv=setInterval(()=>{if(seen())clearInterval(iv)},500);
setTimeout(()=>{if(!seen()){clearInterval(iv);f.textContent="@${o.handle} on X couldn't be shown right now"}},20000);
// X's timeline doesn't refresh itself: rebuild it every 15 minutes for new posts.
setInterval(build,15*60*1000);`,
  );
}

// ---------- reading RSS / Atom feeds ----------

export interface Headline {
  title: string;
  source: string;
}

const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1];

/** Headlines from an RSS or Atom document. Google News titles end in " - Source", which is split off. */
export function parseFeed(xml: string, max = 30): Headline[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return blocks.slice(0, max).flatMap((b) => {
    let title = decode(tag(b, "title") ?? "");
    const source = decode(tag(b, "source") ?? "");
    if (!title) return [];
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return [{ title, source }];
  });
}
