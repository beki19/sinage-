/**
 * HTML for the app widgets: weather, Ethiopian calendar, exchange rates, countdown, QR code, menu board,
 * queue display, calendar agenda, Facebook page and Instagram posts. Same rules as widgets.ts: one
 * self-contained page each, loaded with the CMS as origin; __DEVICE_TOKEN__ is filled in by the player.
 */
import qrcode from "qrcode-generator";
import { page, scriptJson } from "./widgets.js";

interface Colors {
  color: string;
  background: string;
}

/** Shrinks the font of `el` until it fits inside `box`. Shared by several widgets. */
const FIT = `function fit(el,box,max,min){const cs=getComputedStyle(box),H=box.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom),
W=box.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);let lo=min||8,hi=max||400;while(hi-lo>1){const m=(lo+hi)>>1;el.style.fontSize=m+"px";
if(el.scrollHeight<=H&&el.scrollWidth<=W)lo=m;else hi=m;}el.style.fontSize=lo+"px";}`;

/** Fetches the widget's data from the CMS every [everyMs], keeping the last good copy on the device for offline use. */
const LOAD = (itemId: string, everyMs: number) => `const ID=${scriptJson(itemId)},KEY="w:"+ID;
let data=null;try{data=JSON.parse(localStorage.getItem(KEY)||"null")}catch(e){}
async function load(){try{const r=await fetch("/api/player/widget/"+encodeURIComponent(ID),{headers:{authorization:"Device __DEVICE_TOKEN__"}});
if(r.ok){data=await r.json();loadError=false;try{localStorage.setItem(KEY,JSON.stringify(data))}catch(e){}render();return;}}catch(e){}
if(!data){loadError=true;render();}}let loadError=false;
setInterval(load,${everyMs});addEventListener("resize",()=>render());`;

// ---------- weather ----------

export function weatherHtml(o: Colors & { itemId: string; place: string }) {
  return page(
    `body{background:${o.background};color:${o.color}}#w{height:100%;box-sizing:border-box;padding:4vmin;display:flex;flex-direction:column;justify-content:center;gap:.25em;overflow:hidden}
.now{display:flex;align-items:center;gap:4vmin}.big{font-size:1em;line-height:1}.ico{font-size:1.1em;line-height:1}
.city{opacity:.85;font-size:.3em}.desc{font-size:.28em;opacity:.85}.meta{font-size:.2em;opacity:.65;margin-top:.3em}
.days{display:flex;gap:2vmin;font-size:.22em}.day{flex:1;text-align:center;padding:1.5vmin;border-radius:1.5vmin;background:rgba(127,127,127,.12)}
.day b{display:block;opacity:.8}.day span{display:block;font-size:1.6em;margin:.15em 0}.row #w{flex-direction:row;align-items:center}
.row .days{flex:1}`,
    `<div id="w"></div>`,
    `${LOAD(o.itemId, 15 * 60_000)}
const PLACE=${scriptJson(o.place)};
const CODES={0:["☀️","Clear"],1:["🌤️","Mostly clear"],2:["⛅","Partly cloudy"],3:["☁️","Cloudy"],45:["🌫️","Fog"],48:["🌫️","Fog"],
51:["🌦️","Light drizzle"],53:["🌦️","Drizzle"],55:["🌧️","Heavy drizzle"],61:["🌦️","Light rain"],63:["🌧️","Rain"],65:["🌧️","Heavy rain"],
66:["🌧️","Freezing rain"],67:["🌧️","Freezing rain"],71:["🌨️","Light snow"],73:["🌨️","Snow"],75:["❄️","Heavy snow"],77:["🌨️","Snow grains"],
80:["🌦️","Showers"],81:["🌧️","Showers"],82:["⛈️","Heavy showers"],85:["🌨️","Snow showers"],86:["🌨️","Snow showers"],95:["⛈️","Thunderstorm"],96:["⛈️","Thunderstorm"],99:["⛈️","Thunderstorm"]};
const w=document.getElementById("w");
function render(){if(!data){w.textContent="Loading weather…";return;}
const c=data.current,u=data.units==="f"?"°F":"°C",[ico,desc]=CODES[c.code]||["🌡️",""],night=!c.day&&(c.code<=1);
const W=innerWidth,H=innerHeight,wide=W>H*2.2;document.body.className=wide?"row":"";
const size=Math.min(H*(wide?0.6:0.32),W*(wide?0.12:0.22));w.style.fontSize=size+"px";
const days=data.days.slice(wide?0:0,wide?4:(W>H?5:3)).map(d=>{const [i]=CODES[d.code]||["🌡️"];
return '<div class="day"><b>'+new Date(d.date+"T12:00").toLocaleDateString(undefined,{weekday:"short"})+'</b><span>'+i+'</span>'+Math.round(d.max)+'° / '+Math.round(d.min)+'°</div>'}).join("");
w.innerHTML='<div class="now"><div class="ico">'+(night?"🌙":ico)+'</div><div><div class="city"></div><div class="big">'+Math.round(c.temp)+u+'</div><div class="desc">'+desc+'</div>'
+'<div class="meta">Feels '+Math.round(c.feels)+'° · Humidity '+Math.round(c.humidity)+'% · Wind '+Math.round(c.wind)+(data.units==="f"?" mph":" km/h")+'</div></div></div>'
+(H>W*0.35||wide?'<div class="days">'+days+'</div>':"");
w.querySelector(".city").textContent=PLACE;
// Shrink until everything fits the zone.
let lo=8,hi=Math.ceil(size);while(hi-lo>1){const m=(lo+hi)>>1;w.style.fontSize=m+"px";if(w.scrollHeight<=w.clientHeight&&w.scrollWidth<=w.clientWidth)lo=m;else hi=m;}w.style.fontSize=lo+"px";}
render();load();`,
  );
}

// ---------- Ethiopian calendar ----------

export function ethCalendarHtml(o: Colors & { amharic: boolean; ethiopianTime: boolean; showGregorian: boolean }) {
  return page(
    `body{background:${o.background};color:${o.color}}#b{height:100%;box-sizing:border-box;padding:4vmin;display:flex;align-items:center;justify-content:center}
#c{text-align:center;white-space:nowrap}.d{font-weight:700;line-height:1.1}.w{opacity:.85;font-size:.45em}.t{font-size:.9em;font-weight:700;font-variant-numeric:tabular-nums;margin-top:.15em}
.p{font-size:.32em;opacity:.8}.g{font-size:.32em;opacity:.6;margin-top:.4em}`,
    `<div id="b"><div id="c"></div></div>`,
    `${FIT}
const AM=${o.amharic},ETT=${o.ethiopianTime},GREG=${o.showGregorian};
const MON_AM=["መስከረም","ጥቅምት","ኅዳር","ታኅሣሥ","ጥር","የካቲት","መጋቢት","ሚያዝያ","ግንቦት","ሰኔ","ሐምሌ","ነሐሴ","ጳጉሜን"];
const MON_EN=["Meskerem","Tikimt","Hidar","Tahsas","Tir","Yekatit","Megabit","Miyazya","Ginbot","Sene","Hamle","Nehase","Pagume"];
const DAY_AM=["እሑድ","ሰኞ","ማክሰኞ","ረቡዕ","ሐሙስ","ዓርብ","ቅዳሜ"],DAY_EN=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
// Gregorian date -> Julian day number -> Ethiopian (Amete Mihret) date.
function jdn(y,m,d){const a=Math.floor((14-m)/12),yy=y+4800-a,mm=m+12*a-3;return d+Math.floor((153*mm+2)/5)+365*yy+Math.floor(yy/4)-Math.floor(yy/100)+Math.floor(yy/400)-32045;}
function eth(j){const o=1723856,r=((j-o)%1461+1461)%1461,n=(r%365)+365*Math.floor(r/1460);
return{y:4*Math.floor((j-o)/1461)+Math.floor(r/365)-Math.floor(r/1460),m:Math.floor(n/30)+1,d:(n%30)+1};}
const c=document.getElementById("c"),b=document.getElementById("b");let last="";
function parts(){const p=new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Addis_Ababa",year:"numeric",month:"numeric",day:"numeric",hour:"numeric",minute:"2-digit",hourCycle:"h23",weekday:"short"}).formatToParts(new Date());
const g=t=>p.find(x=>x.type===t).value;return{y:+g("year"),m:+g("month"),d:+g("day"),h:+g("hour"),mi:g("minute"),wd:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(g("weekday"))};}
function tick(){const t=parts(),e=eth(jdn(t.y,t.m,t.d));
const date=AM?MON_AM[e.m-1]+" "+e.d+" ቀን "+e.y+" ዓ.ም":MON_EN[e.m-1]+" "+e.d+", "+e.y;
let time,period="";if(ETT){const h=(t.h+6)%12||12;time=h+":"+t.mi;
period=AM?(t.h>=6&&t.h<12?"ጠዋት":t.h>=12&&t.h<18?"ከሰዓት":t.h>=18?"ማታ":"ሌሊት"):(t.h>=6&&t.h<12?"morning":t.h>=12&&t.h<18?"afternoon":t.h>=18?"evening":"night")+" (Ethiopian time)";}
else time=String(t.h).padStart(2,"0")+":"+t.mi;
const greg=new Date().toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long",year:"numeric",timeZone:"Africa/Addis_Ababa"});
const key=date+time;if(key===last)return;last=key;
c.innerHTML='<div class="w"></div><div class="d"></div><div class="t"></div><div class="p"></div>'+(GREG?'<div class="g"></div>':"");
c.querySelector(".w").textContent=AM?DAY_AM[t.wd]:DAY_EN[t.wd];c.querySelector(".d").textContent=date;c.querySelector(".t").textContent=time;
c.querySelector(".p").textContent=period;if(GREG)c.querySelector(".g").textContent=greg;fit(c,b,500,10);}
tick();setInterval(tick,1000);addEventListener("resize",()=>{last="";tick();});`,
  );
}

// ---------- exchange rates ----------

export const CURRENCIES: Record<string, [string, string]> = {
  USD: ["🇺🇸", "US Dollar"], EUR: ["🇪🇺", "Euro"], GBP: ["🇬🇧", "British Pound"], SAR: ["🇸🇦", "Saudi Riyal"], AED: ["🇦🇪", "UAE Dirham"],
  CNY: ["🇨🇳", "Chinese Yuan"], JPY: ["🇯🇵", "Japanese Yen"], CHF: ["🇨🇭", "Swiss Franc"], CAD: ["🇨🇦", "Canadian Dollar"], AUD: ["🇦🇺", "Australian Dollar"],
  KES: ["🇰🇪", "Kenyan Shilling"], INR: ["🇮🇳", "Indian Rupee"], TRY: ["🇹🇷", "Turkish Lira"], KWD: ["🇰🇼", "Kuwaiti Dinar"], QAR: ["🇶🇦", "Qatari Riyal"],
  ZAR: ["🇿🇦", "South African Rand"], SEK: ["🇸🇪", "Swedish Krona"], NOK: ["🇳🇴", "Norwegian Krone"], DKK: ["🇩🇰", "Danish Krone"], ETB: ["🇪🇹", "Ethiopian Birr"],
  DJF: ["🇩🇯", "Djiboutian Franc"], EGP: ["🇪🇬", "Egyptian Pound"], NGN: ["🇳🇬", "Nigerian Naira"], BHD: ["🇧🇭", "Bahraini Dinar"], OMR: ["🇴🇲", "Omani Rial"],
};

export function ratesHtml(o: Colors & { itemId: string; title: string; base: string; manual: boolean }) {
  return page(
    `body{background:${o.background};color:${o.color}}#b{height:100%;box-sizing:border-box;padding:3vmin}#c{width:100%}
h1{margin:0 0 .4em;font-size:1.1em}table{width:100%;border-collapse:collapse}th{text-align:right;font-size:.6em;opacity:.65;font-weight:600;padding:0 .4em .3em}
th:first-child{text-align:left}td{padding:.22em .4em;border-top:1px solid rgba(127,127,127,.25);font-variant-numeric:tabular-nums}
td.n{text-align:right;font-weight:700}td small{opacity:.6;font-size:.6em;margin-left:.4em}.f{opacity:.55;font-size:.45em;margin-top:.5em}`,
    `<div id="b"><div id="c"></div></div>`,
    `${FIT}${LOAD(o.itemId, 30 * 60_000)}
const TITLE=${scriptJson(o.title)},BASE=${scriptJson(o.base)},NAMES=${scriptJson(CURRENCIES)},MANUAL=${o.manual};
const c=document.getElementById("c"),b=document.getElementById("b");
const fmt=v=>v>=100?v.toFixed(2):v>=1?v.toFixed(4):v.toFixed(6);
function render(){if(!data){c.textContent="Loading rates…";return;}
const rows=data.rows.map(r=>{const n=NAMES[r.code]||["",""];return'<tr><td>'+n[0]+' <b>'+r.code+'</b><small>'+n[1]+'</small></td>'
+(MANUAL?'<td class="n">'+(r.buy!=null?fmt(r.buy):"–")+'</td><td class="n">'+(r.sell!=null?fmt(r.sell):"–")+'</td>':'<td class="n">'+fmt(r.rate)+'</td>')+'</tr>'}).join("");
c.innerHTML=(TITLE?'<h1></h1>':"")+'<table><tr><th>Currency</th>'+(MANUAL?'<th>Buying</th><th>Selling</th>':'<th>'+BASE+'</th>')+'</tr>'+rows+'</table>'
+'<div class="f">'+(MANUAL?"":"Indicative mid-market rates · ")+'Updated '+new Date(data.updated||Date.now()).toLocaleString()+'</div>';
if(TITLE)c.querySelector("h1").textContent=TITLE;fit(c,b,120,8);}
render();load();`,
  );
}

// ---------- countdown ----------

export function countdownHtml(o: Colors & { title: string; target: string; doneText: string }) {
  return page(
    `body{background:${o.background};color:${o.color}}#b{height:100%;box-sizing:border-box;padding:4vmin;display:flex;align-items:center;justify-content:center}
#c{text-align:center;white-space:nowrap}h1{margin:0 0 .3em;font-size:.45em;font-weight:600}.u{display:inline-block;margin:0 .15em;min-width:1.6em}
.u b{display:block;font-variant-numeric:tabular-nums;line-height:1}.u span{display:block;font-size:.25em;line-height:1.2;opacity:.7;text-transform:uppercase;letter-spacing:.1em}`,
    `<div id="b"><div id="c"></div></div>`,
    `${FIT}const TITLE=${scriptJson(o.title)},TARGET=${scriptJson(o.target)},DONE=${scriptJson(o.doneText)};
const c=document.getElementById("c"),b=document.getElementById("b");let shape="";
function tick(){const left=Math.max(0,new Date(TARGET).getTime()-Date.now());
if(!left){if(shape!=="done"){shape="done";c.innerHTML="<h1></h1>";c.firstChild.textContent=DONE||TITLE;c.firstChild.style.fontSize="1em";fit(c,b,400,10);}return;}
const s=Math.floor(left/1000),parts=[[Math.floor(s/86400),"days"],[Math.floor(s/3600)%24,"hours"],[Math.floor(s/60)%60,"min"],[s%60,"sec"]];
const want=parts.map(p=>p[1]).join();if(shape!==want){shape=want;
c.innerHTML=(TITLE?"<h1></h1>":"")+parts.map(p=>'<div class="u"><b></b><span>'+p[1]+'</span></div>').join("");if(TITLE)c.querySelector("h1").textContent=TITLE;}
c.querySelectorAll(".u b").forEach((el,i)=>el.textContent=String(parts[i][0]).padStart(2,"0"));if(shape===want&&!c.dataset.fitted){fit(c,b,400,10);c.dataset.fitted=1;}}
tick();setInterval(tick,250);addEventListener("resize",()=>{delete c.dataset.fitted;tick();});`,
  );
}

// ---------- QR code ----------

/** The QR code is drawn on the CMS, so screens don't need a QR library. */
export function qrHtml(o: Colors & { text: string; caption: string }) {
  const qr = qrcode(0, "M");
  qr.addData(o.text);
  qr.make();
  const n = qr.getModuleCount();
  let path = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) path += `M${x + 4},${y + 4}h1v1h-1z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  return page(
    `body{background:${o.background};color:${o.color}}#b{height:100%;box-sizing:border-box;padding:5vmin;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3vmin}
#q{flex:1;min-height:0;aspect-ratio:1;max-width:100%}#q svg{width:100%;height:100%;border-radius:2vmin}#t{text-align:center;font-weight:600;line-height:1.2;max-width:100%}`,
    `<div id="b"><div id="q">${svg}</div><div id="t"></div></div>`,
    `const t=document.getElementById("t"),CAP=${scriptJson(o.caption)};t.textContent=CAP;t.hidden=!CAP;
function size(){const W=innerWidth,H=innerHeight;t.style.fontSize=Math.max(12,Math.min(W/14,H/12))+"px";
document.getElementById("b").style.flexDirection=W>H*1.6&&CAP?"row":"column";}size();addEventListener("resize",size);`,
  );
}

// ---------- menu / price board ----------

export interface MenuSection {
  name: string;
  items: { name: string; price: string; note: string }[];
}

export function menuHtml(o: Colors & { title: string; currency: string; sections: MenuSection[]; accent: string }) {
  return page(
    `body{background:${o.background};color:${o.color}}#b{height:100%;box-sizing:border-box;padding:3.5vmin}#c{height:100%;display:flex;flex-direction:column}
h1{margin:0 0 .5em;text-align:center;font-size:1.6em;letter-spacing:.03em}#cols{flex:1;column-gap:2em;column-fill:balance}
.s{break-inside:avoid;margin-bottom:.9em}.s h2{margin:0 0 .35em;font-size:1.05em;color:${o.accent};text-transform:uppercase;letter-spacing:.08em}
.i{display:flex;align-items:baseline;gap:.4em;margin:.25em 0}.i .n{font-weight:600}.i .dots{flex:1;border-bottom:.08em dotted rgba(127,127,127,.6);transform:translateY(-.25em)}
.i .p{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}.note{font-size:.72em;opacity:.7;margin:-.15em 0 .3em}`,
    `<div id="b"><div id="c"></div></div>`,
    `const M=${scriptJson(o)};const c=document.getElementById("c"),b=document.getElementById("b");
function esc(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML;}
function render(){const items=M.sections.reduce((n,s)=>n+s.items.length+2,0),W=innerWidth,H=innerHeight;
const cols=Math.max(1,Math.min(4,Math.round(Math.sqrt(items*(W/H)/6))));
c.innerHTML=(M.title?"<h1>"+esc(M.title)+"</h1>":"")+'<div id="cols" style="column-count:'+cols+'">'+M.sections.map(s=>'<div class="s">'+(s.name?"<h2>"+esc(s.name)+"</h2>":"")
+s.items.map(i=>'<div class="i"><span class="n">'+esc(i.name)+'</span><span class="dots"></span><span class="p">'+esc(i.price?(M.currency?M.currency+" ":"")+i.price:"")+'</span></div>'+(i.note?'<div class="note">'+esc(i.note)+'</div>':"")).join("")+'</div>').join("")+'</div>';
const cols2=document.getElementById("cols");let lo=8,hi=200;while(hi-lo>1){const m=(lo+hi)>>1;c.style.fontSize=m+"px";
if(cols2.scrollHeight<=cols2.clientHeight+1&&cols2.scrollWidth<=cols2.clientWidth+1&&c.scrollHeight<=b.clientHeight)lo=m;else hi=m;}c.style.fontSize=lo+"px";}
render();addEventListener("resize",render);`,
  );
}

// ---------- queue / now serving ----------

export function queueHtml(o: Colors & { itemId: string; title: string; accent: string }) {
  return page(
    `body{background:${o.background};color:${o.color}}#b{height:100%;box-sizing:border-box;padding:4vmin;display:flex;align-items:center;justify-content:center}
#c{text-align:center;white-space:nowrap}h1{margin:0;font-size:.28em;font-weight:600;opacity:.85;text-transform:uppercase;letter-spacing:.12em}
.num{font-size:1em;font-weight:800;line-height:1.05;color:${o.accent};font-variant-numeric:tabular-nums}.ctr{font-size:.3em;font-weight:600}
.hist{font-size:.18em;opacity:.6;margin-top:.6em}.flash{animation:f 1.2s ease 3}@keyframes f{50%{opacity:.25}}`,
    `<div id="b"><div id="c"></div></div>`,
    `${FIT}${LOAD(o.itemId, 1500)}
const TITLE=${scriptJson(o.title)};const c=document.getElementById("c"),b=document.getElementById("b");let shown=null;
function chime(){try{const a=new (window.AudioContext||window.webkitAudioContext)();[0,.18].forEach((t,i)=>{const g=a.createGain(),o=a.createOscillator();
o.frequency.value=i?660:880;g.gain.setValueAtTime(.0001,a.currentTime+t);g.gain.exponentialRampToValueAtTime(.4,a.currentTime+t+.02);
g.gain.exponentialRampToValueAtTime(.0001,a.currentTime+t+.5);o.connect(g).connect(a.destination);o.start(a.currentTime+t);o.stop(a.currentTime+t+.55);});}catch(e){}}
function render(){if(!data){c.textContent="…";return;}const key=data.label+"|"+(data.counter||"");
c.innerHTML="<h1></h1><div class=num></div><div class=ctr></div><div class=hist></div>";c.querySelector("h1").textContent=TITLE||"Now serving";
c.querySelector(".num").textContent=data.label;c.querySelector(".ctr").textContent=data.counter?"→ "+data.counter:"";
c.querySelector(".hist").textContent=(data.history||[]).length?"Before: "+data.history.join("  ·  "):"";fit(c,b,600,10);
if(shown!==null&&shown!==key){c.querySelector(".num").classList.add("flash");chime();}shown=key;}
render();load();`,
  );
}

// ---------- calendar agenda ----------

export function calendarHtml(o: Colors & { itemId: string; title: string; accent: string }) {
  return page(
    `body{background:${o.background};color:${o.color}}#b{height:100%;box-sizing:border-box;padding:3.5vmin;overflow:hidden}
h1{margin:0 0 .5em;font-size:1.25em}.day{font-size:.75em;opacity:.65;text-transform:uppercase;letter-spacing:.08em;margin:.7em 0 .3em}
.e{display:flex;gap:.8em;padding:.4em .6em;border-radius:.4em;margin-bottom:.3em;background:rgba(127,127,127,.1)}
.e.now{background:${o.accent};color:#fff}.e .t{font-variant-numeric:tabular-nums;font-weight:700;min-width:5.5em}.e small{display:block;opacity:.75;font-size:.75em}
.none{opacity:.6}`,
    `<div id="b"></div>`,
    `${LOAD(o.itemId, 5 * 60_000)}
const TITLE=${scriptJson(o.title)};const b=document.getElementById("b");
function esc(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML;}
const tm=d=>new Date(d).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
function render(){const W=innerWidth,H=innerHeight;b.style.fontSize=Math.max(12,Math.min(W/24,H/16))+"px";
if(!data){b.innerHTML=(TITLE?"<h1>"+esc(TITLE)+"</h1>":"")+'<div class="none">'+(loadError?"Couldn't load the calendar. Check its link in the CMS.":"Loading…")+'</div>';return;}
const now=Date.now(),evs=data.events.filter(e=>new Date(e.end).getTime()>now);let html=TITLE?"<h1>"+esc(TITLE)+"</h1>":"",lastDay="";
if(!evs.length)html+='<div class="none">No upcoming events</div>';
for(const e of evs){const day=new Date(e.start).toDateString();if(day!==lastDay){lastDay=day;
html+='<div class="day">'+(day===new Date().toDateString()?"Today":new Date(e.start).toLocaleDateString([],{weekday:"long",day:"numeric",month:"short"}))+"</div>";}
const live=new Date(e.start).getTime()<=now;html+='<div class="e'+(live?" now":"")+'"><span class="t">'+(e.allDay?"All day":tm(e.start)+"–"+tm(e.end))+'</span><span>'+esc(e.title)+(e.location?"<small>"+esc(e.location)+"</small>":"")+"</span></div>";}
b.innerHTML=html;}
render();load();setInterval(render,60000);`,
  );
}

// ---------- social ----------

export function facebookHtml(o: Colors & { pageUrl: string }) {
  return page(
    `body{background:${o.background};color:${o.color};display:flex;justify-content:center}iframe{border:0;height:100%}`,
    `<iframe id="f" scrolling="no" allow="encrypted-media"></iframe>`,
    `const URL_=${scriptJson(o.pageUrl)};const f=document.getElementById("f");
function size(){const w=Math.max(180,Math.min(500,innerWidth)),h=Math.max(70,innerHeight);f.style.width=w+"px";
f.src="https://www.facebook.com/plugins/page.php?tabs=timeline&small_header=true&adapt_container_width=true&hide_cover=false&show_facepile=false"
+"&width="+w+"&height="+h+"&href="+encodeURIComponent(URL_);}size();
// Facebook doesn't refresh the plugin itself: reload it every 20 minutes for new posts.
setInterval(size,20*60*1000);`,
  );
}

export function instagramHtml(o: Colors & { posts: string[]; seconds: number }) {
  return page(
    `body{background:${o.background};color:${o.color};display:flex;justify-content:center;align-items:center}
iframe{border:0;background:#fff;border-radius:8px;height:100%;aspect-ratio:4/6;max-width:100%}`,
    `<iframe id="f" scrolling="no"></iframe>`,
    `const POSTS=${scriptJson(o.posts)},SEC=${o.seconds};const f=document.getElementById("f");let i=0;
function show(){const m=POSTS[i%POSTS.length].match(/instagram\\.com\\/(?:p|reel|tv)\\/([\\w-]+)/);if(m)f.src="https://www.instagram.com/p/"+m[1]+"/embed/captioned/";i++;}
show();if(POSTS.length>1)setInterval(show,SEC*1000);`,
  );
}
