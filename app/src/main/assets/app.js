const $=id=>document.getElementById(id);
const REGEN=Symbol("regen");
let lastChatClientHeight=null;
const state={
  // A fresh app launch always starts a NEW chat; the previous one is already
  // persisted in the Recent list. Restoring the old session here made the app
  // reopen the last chat instead of a fresh one.
  messages:[],
  // Source of truth for branching (retry creates a sibling, not a destructive
  // overwrite). state.messages is always a DERIVED flat view of the currently
  // active path through this tree — see computePath(). Every mutation to the
  // tree must recompute state.messages afterward.
  tree:{rootId:null,nodes:{}},
  models:JSON.parse(localStorage.getItem("models")||"[]"),
  selected:localStorage.getItem("model")||"",
  base:localStorage.getItem("base")||"",
  key:localStorage.getItem("key")||"",
  summary:localStorage.getItem("summary")||"",
  settings:JSON.parse(localStorage.getItem("settings")||'{"input":128000,"output":6000,"auto":true,"threshold":80}'),
  modelContext:JSON.parse(localStorage.getItem("modelContext")||"{}"),
  attachments:[],
  projectName:"",
  wsEnabled:localStorage.getItem("wsEnabled")==="1",
  searchOllama:localStorage.getItem("searchOllama")==="1",
  searchProvider:localStorage.getItem("searchProvider")||"auto",
  ollamaKey:localStorage.getItem("ollamaKey")||"",
  sessions:JSON.parse(localStorage.getItem("sessions")||"[]"),
  projects:JSON.parse(localStorage.getItem("projects")||"[]"),
  extEnabled:JSON.parse(localStorage.getItem("extEnabled")||"{}"),
  extInline:JSON.parse(localStorage.getItem("extInline")||"[]"),
  ghToken:localStorage.getItem("ghToken")||"",
  ghUser:localStorage.getItem("ghUser")||"",
  ghClientId:localStorage.getItem("ghClientId")||""
};

function save(){
  try{
    localStorage.setItem("messages",JSON.stringify(state.messages));
  }catch(e){
    // Images blow past the ~5MB localStorage quota. Degrade gracefully:
    // newest messages keep images, older ones keep only names, so history survives.
    let msgs=state.messages.slice();
    let ok=false;
    for(let drop=0;drop<msgs.length&&!ok;drop++){
      const attempt=msgs.map((m,i)=>i<msgs.length-1-drop?{...m,attachments:(m.attachments||[]).map(a=>({name:a.name,kind:a.kind}))}:m);
      try{localStorage.setItem("messages",JSON.stringify(attempt));ok=true}catch(_){}
    }
    if(!ok){
      try{localStorage.setItem("messages","[]")}catch(_){}
    }
  }
  localStorage.setItem("models",JSON.stringify(state.models));
  localStorage.setItem("model",state.selected);
  localStorage.setItem("base",state.base);
  localStorage.setItem("key",state.key);
  localStorage.setItem("summary",state.summary);
  localStorage.setItem("settings",JSON.stringify(state.settings));
  localStorage.setItem("modelContext",JSON.stringify(state.modelContext));
  localStorage.setItem("wsEnabled",state.wsEnabled?"1":"0");
  localStorage.setItem("searchOllama",state.searchOllama?"1":"0");
  localStorage.setItem("searchProvider",state.searchProvider);
  localStorage.setItem("ollamaKey",state.ollamaKey);
  localStorage.setItem("sessions",JSON.stringify(state.sessions));
  localStorage.setItem("projects",JSON.stringify(state.projects));
  localStorage.setItem("extEnabled",JSON.stringify(state.extEnabled));
  localStorage.setItem("extInline",JSON.stringify(state.extInline));
  localStorage.setItem("ghToken",state.ghToken);
  localStorage.setItem("ghUser",state.ghUser);
  localStorage.setItem("ghClientId",state.ghClientId);
}

/* ── System banner (non-chat status messages) ── */
function showBanner(text){
  hideBanner();
  const chat=$("chat");
  chat.insertAdjacentHTML("beforeend",`<div class="sys-banner" id="sysBanner"><svg><use href="#i-check"/></svg><span>${esc(text)}</span></div>`);
  autoScroll();
}
function hideBanner(){const b=$("sysBanner");if(b)b.remove()}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function unesc(s){return String(s).replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g,c=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'"}[c]))}
async function copyToClipboard(text){
  try{await navigator.clipboard.writeText(text);return true}catch(e){}
  try{
    const ta=document.createElement("textarea");
    ta.value=text;ta.style.position="fixed";ta.style.opacity="0";
    document.body.appendChild(ta);ta.focus();ta.select();
    const ok=document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }catch(e){return false}
}
function md(s,opts={}){
  const blocks=[];
  const placeholder=html=>{const i=blocks.length;blocks.push(html);return `\u0000${i}\u0000`};
  let t=String(s||"");
  // Extract reasoning BEFORE escaping so raw tags never leak into the bubble.
  // Known thinking-tag pairs: extend this list as new models appear.
  const THINK_TAGS=[["think","think"],["thinking","thinking"],["reasoning","reasoning"],["thought","thought"]];
  for(const [open,close] of THINK_TAGS){
    const re=new RegExp(`<${open}(\\s[^>]*)?>\s*([\s\S]*?)\s*</${close}(\s[^>]*)?>`,"gi");
    t=t.replace(re,(_,__,thought)=>
      placeholder(`<details class="reasoning-block"><summary><span class="reasoning-label">Reasoning</span><span class="reasoning-time">Thought for ${formatReasoningTime(opts.reasoningDurationMs)}</span></summary><pre>${esc(thought.trim())}</pre></details>`));
    // Truncated/dangling tag: strip the tag itself, keep the text out of the UI.
    t=t.replace(new RegExp(`</?${open}(\\s[^>]*)?>`,"gi"),"");
  }
  let x=esc(t);
  x=x.replace(/```([\w+-]*)\n?([\s\S]*?)```/g,(_,lang,code)=>{
    const clean=code.replace(/\n$/,"");
    return placeholder(`<pre class="code-block">${lang?`<div class="code-lang">${esc(lang)}</div>`:""}<button class="code-copy-btn" data-code="${encodeURIComponent(unesc(clean))}" aria-label="Copy code"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg></button><code>${clean}</code></pre>`);
  });
  x=x.replace(/`([^`\n]+)`/g,(_,code)=>placeholder(`<code class="inline-code">${code}</code>`));
  const lines=x.split("\n");let out=[],inUl=false,inOl=false;
  const closeLists=()=>{if(inUl){out.push("</ul>");inUl=false}if(inOl){out.push("</ol>");inOl=false}};
  for(const line of lines){
    if(!line.trim()){closeLists();continue}
    let m=line.match(/^\s*[-*+]\s+(.+)$/);if(m){if(!inUl){closeLists();out.push("<ul>");inUl=true}out.push("<li>"+m[1]+"</li>");continue}
    m=line.match(/^\s*\d+[.)]\s+(.+)$/);if(m){if(!inOl){closeLists();out.push("<ol>");inOl=true}out.push("<li>"+m[1]+"</li>");continue}
    closeLists();
    if(/^###\s+/.test(line)){out.push("<h3>"+line.replace(/^###\s+/,"")+"</h3>");continue}
    if(/^##\s+/.test(line)){out.push("<h2>"+line.replace(/^##\s+/,"")+"</h2>");continue}
    if(/^#\s+/.test(line)){out.push("<h1>"+line.replace(/^#\s+/,"")+"</h1>");continue}
    if(/^>\s?/.test(line)){out.push("<blockquote>"+line.replace(/^>\s?/,"")+"</blockquote>");continue}
    out.push("<p>"+line+"</p>");
  }
  closeLists();
  let html=out.join("");
  html=html.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>").replace(/__([^_\n]+)__/g,"<strong>$1</strong>");
  html=html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g,"<em>$1</em>").replace(/(?<!_)_([^_\n]+)_(?!_)/g,"<em>$1</em>");
  html=html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  html=html.replace(/\u0000(\d+)\u0000/g,(_,i)=>blocks[Number(i)]);
  return '<div class="markdown">'+html+"</div>";
}
function formatReasoningTime(ms){
  const sec=Math.max(1,Math.round((Number(ms)||0)/1000));
  return sec+"s";
}
/* Splits hidden reasoning out of a raw model response. Same tag list as md()/strip(). */
function extractReasoning(text){
  const TAGS=[["think","think"],["thinking","thinking"],["reasoning","reasoning"],["thought","thought"]];
  let thinking="";
  let rest=String(text||"");
  for(const [open,close] of TAGS){
    const re=new RegExp(`<${open}(\\s[^>]*)?>\s*([\s\S]*?)\s*</${close}(\s[^>]*)?>`,"gi");
    rest=rest.replace(re,(_,__,thought)=>{thinking+=thought.trim()+"\n";return ""});
    rest=rest.replace(new RegExp(`</?${open}(\\s[^>]*)?>`,"gi"),"");
  }
  return {thinking:thinking.trim(),rest:rest.trim()};
}
function welcomeHtml(){
  const projectSub=state.projectName?"Connected: "+esc(state.projectName):"Continue coding";
  return `<section id="welcome" class="welcome">
    <div class="star"><svg><use href="#i-moon"/></svg></div>
    <h1>Hello, night owl</h1>
    <button class="quick" id="newChat">
      <span class="quick-ico"><svg><use href="#i-plus"/></svg></span>
      <span class="quick-text"><b>New chat</b></span>
      <span class="quick-arrow"><svg><use href="#i-arrow-r"/></svg></span>
    </button>
    <button class="quick" id="openProjectCard">
      <span class="quick-ico"><svg><use href="#i-folder"/></svg></span>
      <span class="quick-text"><b>Projects</b><small id="openProjectSub">${projectSub}</small></span>
      <span class="quick-arrow"><svg><use href="#i-arrow-r"/></svg></span>
    </button>
    <button class="quick" onclick="openConsole()">
      <span class="quick-ico"><svg><use href="#i-term"/></svg></span>
      <span class="quick-text"><b>Console</b><small>Shell, JS REPL, logs</small></span>
      <span class="quick-arrow"><svg><use href="#i-arrow-r"/></svg></span>
    </button>
  </section>`;
}
function siblingInfo(m){
  const node=state.tree.nodes[m.id];
  const parent=node&&node.parentId?state.tree.nodes[node.parentId]:null;
  if(!parent||parent.children.length<2)return null;
  return {index:parent.children.indexOf(m.id)+1,total:parent.children.length};
}
function messageHtml(m,idx){
  const files=(m.attachments||[]).map(a=>{
    if(a.kind==="image"&&a.dataUrl)return `<div class="file-card image-card"><img src="${a.dataUrl}"><span class="file-name">${esc(a.name)}</span></div>`;
    const meta=a.kind==="image"?"image":(a.mime||"file");
    return `<div class="file-card"><svg><use href="#i-file"/></svg><span class="file-name">${esc(a.name)}</span><small>${esc(meta)}</small></div>`;
  }).join("");
  const showBubble=m.text||m.role!=="user";
  if(!showBubble)return `<div class="message ${m.role}">${files}</div>`;
  const tools=(m.tools||[]).map(t=>`<details class="tool-activity compact"><summary class="tool-activity-head"><div class="tool-activity-icon sm">${toolIcon(t.name)}</div><div class="tool-activity-text"><div class="tool-activity-title">${esc(toolCompactLabel(t))}</div></div><div class="reasoning-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div></summary><div class="tool-preview">${toolPreview(t.name,t.input,t.result)}</div></details>`).join("");
  // Blocks are the canonical format: [{text},{tool},{text},...] rendered in
  // order inside ONE bubble ￢ﾀﾔ like Claude Code's transcript. m.text stays as
  // the plain-text fallback (legacy chats, search, export).
  const blockToolHtml=t=>`<details class="tool-activity compact"><summary class="tool-activity-head"><div class="tool-activity-icon sm">${toolIcon(t.name)}</div><div class="tool-activity-text"><div class="tool-activity-title">${esc(toolCompactLabel(t))}</div></div><div class="reasoning-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div></summary><div class="tool-preview">${toolPreview(t.name,t.input,t.result)}</div></details>`;
  const blocks=m.blocks||[];
  const blockHtml=blocks.length?`<div class="bubble-blocks">${blocks.map(b=>b.tool?blockToolHtml(b.tool):`<div class="bubble-block-text">${md(b.text||"",{reasoningDurationMs:m.reasoning})}</div>`).join("")}</div>`:"";
  const time=m.ts?`<div class="msg-time">${new Date(m.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>`:"";
  // Thinking arrives as its own field (collected from the API's thinking blocks) —
  // rendered as an agent-style collapsible card ABOVE the bubble. Never merged
  // into m.text, never regex-split. Legacy chats (saved before this field existed)
  // still carry <think>…</think> inside m.text — fallback extracts it once.
  let reasoningHtml="";
  if(m.role==="assistant"){
    let thinking=m.thinking;
    if(!thinking){
      const legacy=extractReasoning(m.text);
      if(legacy.thinking)thinking=legacy.thinking;
    }
    if(thinking){
      const dur=m.reasoning?formatReasoningTime(m.reasoning):null;
      reasoningHtml=`<details class="tool-activity compact reasoning-card"><summary class="tool-activity-head"><div class="tool-activity-icon sm"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a4.5 4.5 0 0 0-4.5 4.5c0 .7.2 1.4.5 2A4 4 0 0 0 5 13.5 4 4 0 0 0 9 17.5h.5A3.5 3.5 0 0 0 12 20a3.5 3.5 0 0 0 2.5-2.5H15a4 4 0 0 0 4-4 4 4 0 0 0-3-3.8c.3-.6.5-1.3.5-2A4.5 4.5 0 0 0 12 3z"/></svg></div><div class="tool-activity-text"><div class="tool-activity-title">Thinking</div><div class="tool-activity-sub">Thought for ${dur||"a moment"}</div></div><div class="reasoning-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div></summary><div class="tool-preview"><pre>${esc(thinking)}</pre></div></details>`;
    }
  }
  const bodyText=m.text;
  const bubbleHtml=blocks.length?"":(m.role==="assistant"?md(bodyText,{reasoningDurationMs:m.reasoning}):esc(m.text||""));
  const retryBtn=m.role==="assistant"?`<button class="msg-act-btn" data-act="retry" aria-label="Retry"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 3 6.7"/><path d="M3 21v-6h6"/></svg></button>`:"";
  const editBtn=m.role==="user"?`<button class="msg-act-btn" data-act="edit" aria-label="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>`:"";
  const actions=`<div class="msg-actions"><button class="msg-act-btn" data-act="copy" aria-label="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg></button>${editBtn}${retryBtn}</div>`;
  const sib=siblingInfo(m);
  const switcherHtml=sib?`<div class="msg-variant-switch" data-node="${m.id}">
    <button class="msg-act-btn" data-act="prevVariant" ${sib.index<=1?"disabled":""} aria-label="Previous variant"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
    <span class="msg-variant-count">${sib.index}/${sib.total}</span>
    <button class="msg-act-btn" data-act="nextVariant" ${sib.index>=sib.total?"disabled":""} aria-label="Next variant"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
  </div>`:"";
  return `<div class="message ${m.role}" data-idx="${idx}">${files}${tools}${reasoningHtml}${blockHtml}<div class="bubble" style="${blocks.length?"display:none":""}">${bubbleHtml}</div>${time}${switcherHtml}${actions}</div>`;
}
function render(){
  const chat=$("chat");
  if(!state.messages.length){
    chat.innerHTML=welcomeHtml();
    const nc=$("newChat");if(nc)nc.onclick=()=>newChat();
    return;
  }
  const prevScrollTop=chat.scrollTop;
  chat.innerHTML=state.messages.map(messageHtml).join("");
  // Full re-render keeps the stick state: jump down only if we were at bottom.
  // Otherwise restore where the reader was — innerHTML replacement resets
  // scrollTop to 0, which would flash-jump to the top on every branch switch.
  if(stickToBottom)chat.scrollTop=chat.scrollHeight;
  else chat.scrollTop=prevScrollTop;
  updateScrollBtn();
}
function showTyping(){
  removeTyping();
  const chat=$("chat");
  chat.insertAdjacentHTML("beforeend",'<div class="message assistant" id="typing"><div class="assistant-activity"><span class="activity-dots"><i></i><i></i><i></i></span><span>Thinking</span></div></div>');
  autoScroll();
}
function removeTyping(){const t=$("typing");if(t)t.remove()}

/* ── Smart auto-scroll: stick to bottom ONLY while the user is already there.
   Scrolling up to read detaches; a jump-to-bottom button reattaches. ── */
let stickToBottom=true;
function chatNearBottom(){
  const c=$("chat");
  if(!c)return true;
  return c.scrollHeight-c.scrollTop-c.clientHeight<80;
}
function scrollToBottom(force){
  const c=$("chat");
  if(!c)return;
  if(force)stickToBottom=true;
  c.scrollTop=c.scrollHeight;
  updateScrollBtn();
}
function autoScroll(){
  if(stickToBottom)scrollToBottom(false);
  else updateScrollBtn();
}
function updateScrollBtn(){
  const btn=$("scrollDownBtn");
  if(!btn)return;
  const show=!chatNearBottom();
  btn.classList.toggle("show",show);
}
(function initScrollWatcher(){
  document.addEventListener("DOMContentLoaded",()=>{
    const c=$("chat");
    if(!c)return;
    c.addEventListener("scroll",()=>{
      const near=chatNearBottom();
      if(near)stickToBottom=true;
      else if(c.scrollHeight-c.scrollTop-c.clientHeight>200)stickToBottom=false;
      updateScrollBtn();
    },{passive:true});
  });
})();

/* ── Native HTTP bridge (bypasses CORS entirely: no origin, no preflight) ── */
const httpCbs={};let httpCbId=0;
window.__httpResult=function(cbId,status,body,error){
  const cb=httpCbs[cbId];if(!cb)return;
  delete httpCbs[cbId];
  cb({status,body,error:!!error});
};
/* ── Streaming client (SSE via native bridge) ── */
const streamCbs={};let streamCbId=0;
let activeStreamCbId=null;
window.__streamChunk=function(cbId,data){
  const cb=streamCbs[cbId];if(cb&&cb.onChunk)cb.onChunk(data);
};
window.__streamDone=function(cbId,status,errMsg,error,cancelled){
  const cb=streamCbs[cbId];if(!cb)return;
  delete streamCbs[cbId];
  if(activeStreamCbId===cbId)activeStreamCbId=null;
  cb.onDone({status,errMsg,error:!!error,cancelled:!!cancelled});
};
function cancelActiveStream(){
  if(!activeStreamCbId)return;
  if(window.Android&&Android.httpStreamCancel)Android.httpStreamCancel(activeStreamCbId);
  activeStreamCbId=null;
}
function httpStream(method,url,headers={},body="",onChunk){
  return new Promise(resolve=>{
    if(!window.Android||!Android.httpStream){
      // Browser fallback: plain fetch (no SSE in dev browser).
      fetch(url,{method,headers,body:body||undefined})
        .then(async r=>{
          const t=await r.text();
          for(const line of t.split("\n"))if(line.startsWith("data:"))onChunk(line.slice(5).trim());
          resolve({status:r.status,errMsg:"",error:false});
        })
        .catch(e=>resolve({status:0,errMsg:String(e&&e.message||e),error:true}));
      return;
    }
    const cbId="st"+(++streamCbId);
    activeStreamCbId=cbId;
    streamCbs[cbId]={onChunk,onDone:resolve};
    try{Android.httpStream(method,url,JSON.stringify(headers),body,cbId)}
    catch(e){delete streamCbs[cbId];activeStreamCbId=null;resolve({status:0,errMsg:String(e&&e.message||e),error:true})}
  });
}
/* Retries with exponential backoff. Network-level failures (DNS/socket — Android
   freezes background apps and kills their sockets) get extra attempts with longer
   waits: the network is back within seconds after unfreeze, so waiting it out
   beats failing the whole generation. HTTP 5xx: short standard backoff. */
async function withRetry(fn,attempts=5){
  let lastErr=null;
  for(let i=0;i<attempts;i++){
    try{
      const r=await fn();
      if(r&&r.error===false&&r.status>=200&&r.status<500)return r;
      lastErr=r;
      if(r&&r.cancelled)return r;
    }catch(e){lastErr={status:0,errMsg:String(e&&e.message||e),error:true,body:String(e&&e.message||e)}}
    if(i<attempts-1){
      const isNet=lastErr&&(lastErr.error||lastErr.status===0||/resolve host|unreachable|reset|timed out|EOF/i.test(String(lastErr.errMsg||lastErr.body||"")));
      const wait=isNet?2000*Math.pow(2,i):1000*Math.pow(2,i);
      console.log("[NightCode] retry "+(i+2)+"/"+attempts+" in "+wait+"ms ("+(isNet?"network":"http "+(lastErr&&lastErr.status))+")");
      await new Promise(res=>setTimeout(res,wait));
    }
  }
  return lastErr;
}
/* Human-readable message for network failures — usually means the app was
   backgrounded mid-request and Android froze it. */
function netErrMsg(raw){
  const s=String(raw||"");
  if(/resolve host|UnknownHost/i.test(s))return "Сеть отвалилась — похоже, приложение было свёрнуто и Android заморозил соединение. Подожди секунду и отправь ещё раз.";
  if(/unreachable/i.test(s))return "Нет сети. Проверь подключение и повтори.";
  if(/reset|EOF|timed out/i.test(s))return "Соединение оборвалось. Повтори запрос.";
  return null;
}
function httpFetch(method,url,headers={},body){
  return new Promise(resolve=>{
    if(!window.Android||!Android.httpRequest){
      // Browser fallback (dev in a normal browser): plain fetch with full error detail.
      fetch(url,{method,headers,body:body||undefined})
        .then(async r=>resolve({status:r.status,body:await r.text(),error:false}))
        .catch(e=>resolve({status:0,body:String(e&&e.message||e),error:true}));
      return;
    }
    const cbId="http"+(++httpCbId);
    httpCbs[cbId]=resolve;
    try{Android.httpRequest(method,url,JSON.stringify(headers),body||"",cbId)}
    catch(e){delete httpCbs[cbId];resolve({status:0,body:String(e&&e.message||e),error:true})}
  });
}

/* ── Android filesystem bridge ─────── */
const fsCbs={};let fsCbId=0;
window.__fsResult=function(cbId,result,error){
  const cb=fsCbs[cbId];if(!cb)return;
  delete fsCbs[cbId];
  cb(result,error);
};
function fsCall(method,...args){
  return new Promise(resolve=>{
    if(!window.Android||!Android[method]){resolve("NO_BRIDGE",true);return}
    const cbId="fs"+(++fsCbId);
    fsCbs[cbId]=(result,error)=>resolve({result,error:!!error});
    try{Android[method](...args,cbId)}catch(e){delete fsCbs[cbId];resolve({result:String(e),error:true})}
  });
}
/* ── Android SSH bridge (agent remote access over one persistent session) ── */
const sshCbs={};let sshCbId=0;
window.__sshData=function(cbId,line){
  const cb=sshCbs[cbId];if(cb&&cb.onLine)cb.onLine(String(line));
};
window.__sshDone=function(cbId,code,msg,error){
  const cb=sshCbs[cbId];if(!cb)return;
  delete sshCbs[cbId];
  cb.onDone({code,msg,error:!!error});
};
function sshCall(op,...args){
  return new Promise(resolve=>{
    // Accepts op keys ("upload") AND agent tool names ("ssh_upload") —
    // mixing them up previously resolved to NO_BRIDGE even with a live bridge.
    const method={connect:"sshConnect",disconnect:"sshDisconnect",exec:"sshExec",upload:"sshUpload",download:"sshDownload",ssh_exec:"sshExec",ssh_upload:"sshUpload",ssh_download:"sshDownload"}[op];
    if(!window.Android||!Android[method]){resolve({code:-1,msg:"NO_BRIDGE (SSH works in the Android app)",error:true,output:[]});return}
    const cbId="ssh"+(++sshCbId);
    const lines=[];
    sshCbs[cbId]={onLine:l=>lines.push(String(l)),onDone:r=>resolve({...r,output:lines})};
    try{Android[method](...args,cbId)}
    catch(e){delete sshCbs[cbId];resolve({code:-1,msg:String(e&&e.message||e),error:true,output:[]})}
  });
}
function sshExecCollect(command,timeoutSec){
  // exec variant that keeps every output line (for the agent tool result)
  return new Promise(resolve=>{
    if(!window.Android||!Android.sshExec){resolve({code:-1,msg:"NO_BRIDGE (SSH works in the Android app)",error:true,output:[]});return}
    const cbId="ssh"+(++sshCbId);
    const lines=[];
    sshCbs[cbId]={onLine:l=>lines.push(String(l)),onDone:r=>resolve({...r,output:lines})};
    try{Android.sshExec(command,timeoutSec||120,cbId)}
    catch(e){delete sshCbs[cbId];resolve({code:-1,msg:String(e&&e.message||e),error:true,output:[]})}
  });
}
async function sshEnsureConnected(){
  if(window.Android&&Android.sshIsConnected&&Android.sshIsConnected())return {ok:true};
  if(!window.Android||!Android.sshConnect)return {ok:false,msg:"NO_BRIDGE"};
  const r=await sshCall("connect","");
  return r.error?{ok:false,msg:r.msg}:{ok:true};
}
const SSH_TOOLS=[
  {name:"ssh_exec",description:"Run a shell command on the connected SSH server (usually Ubuntu). Returns the command output and exit code. Requires SSH configured in Settings → SSH.",input_schema:{type:"object",properties:{command:{type:"string",description:"Shell command, e.g. 'ls -la /var/www'"},timeoutSec:{type:"integer",description:"Optional timeout in seconds (default 120)"}},required:["command"]}},
  {name:"ssh_upload",description:"Upload a file from the connected project folder to the SSH server via SFTP. Creates remote directories as needed.",input_schema:{type:"object",properties:{localPath:{type:"string",description:"Path inside the project, e.g. 'app.py'"},remotePath:{type:"string",description:"Absolute remote path, e.g. '/var/www/app/app.py'"}},required:["localPath","remotePath"]}},
  {name:"ssh_download",description:"Download a file from the SSH server into the connected project folder via SFTP.",input_schema:{type:"object",properties:{remotePath:{type:"string"},localPath:{type:"string",description:"Path inside the project where the file lands"}},required:["remotePath","localPath"]}}
];
function sshToolsAvailable(){
  if(window.Android&&Android.sshIsConnected&&Android.sshIsConnected())return true;
  return !!(window.Android&&Android.sshSavedHost&&Android.sshSavedHost());
}
async function sshRunTool(name,input){
  const ensure=await sshEnsureConnected();
  if(!ensure.ok)return {result:"SSH_NOT_CONNECTED: "+(ensure.msg||"")+". Configure it in Settings → SSH.",error:true};
  if(name==="ssh_exec"){
    const r=await sshExecCollect(String(input.command||""),Number(input.timeoutSec)||120);
    const out=(r.output||[]).join("\n");
    if(r.error)return {result:(out?out+"\n":"")+String(r.msg||"SSH error"),error:true};
    return {result:"exit code: "+r.code+(out?"\n"+out:"\n(no output)"),error:false};
  }
  if(name==="ssh_upload"||name==="ssh_download"){
    const a=name==="ssh_upload"?[String(input.localPath||""),String(input.remotePath||"")]:[String(input.remotePath||""),String(input.localPath||"")];
    const r=await sshCall(name,a[0],a[1]);
    const text=[...(r.output||[]),String(r.msg||"")].filter(Boolean).join("\n");
    return {result:text||"OK",error:!!r.error};
  }
  return {result:"UNKNOWN_SSH_TOOL",error:true};
}

/* ── GitHub auth + API (device flow OAuth or PAT) ── */
const GH_API="https://api.github.com";
async function ghRequest(method,path,body,rawHeaders){
  if(!state.ghToken)return {status:401,body:"NOT_AUTHENTICATED (Settings → GitHub)",error:true};
  const headers=Object.assign({"authorization":"Bearer "+state.ghToken,"accept":"application/vnd.github+json","user-agent":"NightCode","x-github-api-version":"2022-11-28"},rawHeaders||{});
  const r=await httpFetch(method,GH_API+path,headers,body?JSON.stringify(body):"");
  return {status:r.status,body:r.body,error:r.error||r.status>=400};
}
/* Device Flow (OAuth for installed apps — no client secret, no redirect URI).
   Step 1: POST https://github.com/login/device/code → user_code + device_code.
   Step 2: user opens github.com/login/device in a browser (already logged in),
   enters the code, grants. Step 3: poll POST github.com/login/oauth/access_token
   until "authorization_pending" turns into an access_token. */
async function ghDeviceStart(){
  if(!state.ghClientId)return {error:"NO_CLIENT_ID — paste an OAuth App Client ID in Settings → GitHub (github.com/settings/developers → New OAuth App, callback URL can be anything)"};
  const r=await httpFetch("POST","https://github.com/login/device/code",{"content-type":"application/json","accept":"application/json","user-agent":"NightCode"},JSON.stringify({client_id:state.ghClientId,scope:"repo gist read:org"}));
  if(r.error||r.status>=400)return {error:"GitHub device code failed: HTTP "+r.status+" "+(r.body||"").slice(0,200)};
  try{
    const d=JSON.parse(r.body);
    if(d.error)return {error:"GitHub: "+d.error+" — "+(d.error_description||"")};
    return d; // {device_code,user_code,verification_uri,interval,expires_in}
  }catch(e){return {error:"Bad response from GitHub"}}
}
async function ghDevicePoll(deviceCode,intervalSec){
  const wait=(intervalSec||5)*1000;
  for(let i=0;i<40;i++){ // ~7 min max (GitHub expires codes in 15)
    await new Promise(res=>setTimeout(res,wait));
    const r=await httpFetch("POST","https://github.com/login/oauth/access_token",{"content-type":"application/json","accept":"application/json","user-agent":"NightCode"},JSON.stringify({client_id:state.ghClientId,device_code:deviceCode,grant_type:"urn:ietf:params:oauth:grant-type:device_code"}));
    if(r.error)continue;
    try{
      const d=JSON.parse(r.body);
      if(d.access_token)return {token:d.access_token};
      if(d.error==="authorization_pending")continue;
      if(d.error==="slow_down"){await new Promise(res=>setTimeout(res,3000));continue}
      return {error:"GitHub: "+d.error}; // expired_token / access_denied / unsupported...
    }catch(e){}
  }
  return {error:"Timed out waiting for authorization"};
}
async function ghFetchLogin(){
  const r=await ghRequest("GET","/user");
  if(r.error)return null;
  try{return JSON.parse(r.body).login||null}catch(e){return null}
}
async function ghSaveToken(token){
  state.ghToken=token;save();
  state.ghUser=await ghFetchLogin()||"";save();
  return state.ghUser;
}
/* Agent tool: GitHub REST with token. Auto-JSONifies, truncates, wraps errors. */
const GITHUB_TOOL={name:"github_api",description:"Call the GitHub REST API as the authenticated user (token configured in Settings → GitHub). Works with repos, files, issues, pull requests, releases, search.",input_schema:{type:"object",properties:{method:{type:"string",enum:["GET","POST","PATCH","PUT","DELETE"],description:"HTTP method, default GET"},path:{type:"string",description:"API path, e.g. /repos/{owner}/{repo}/contents/{path} or /user"},body:{type:"object",description:"JSON body for POST/PATCH/PUT"}},required:["path"]}};
function ghToolsAvailable(){return !!state.ghToken}
async function ghRunTool(input){
  const method=(String(input.method||"GET")).toUpperCase();
  const path=String(input.path||"");
  if(!path)return {result:"path required",error:true};
  if(!/^https?:\/\//.test(path)&&!path.startsWith("/"))return {result:"path must start with / (or be a full URL)",error:true};
  // Basic guardrail: no changing auth settings / deleting accounts via API.
  if(/authorization/i.test(path))return {result:"Not allowed",error:true};
  const r=await ghRequest(method,path.startsWith("/")?path:path.replace(GH_API,""),input.body||null);
  let out=String(r.body||"");
  try{out=JSON.stringify(JSON.parse(out),null,1)}catch(e){}
  if(out.length>12000)out=out.slice(0,12000)+"\n… (truncated)";
  return {result:"HTTP "+r.status+"\n"+out,error:!!r.error};
}

async function openProject(){
  if(window.Android&&Android.openProjectPicker){Android.openProjectPicker()}
  else alert("Project folders are available in the Android app.");
}
async function listWorkspaceProjects(){
  const r=await fsCall("listWorkspaceProjects");
  if(r.error)return [];
  return r.result.split("\n").filter(Boolean);
}
async function switchWorkspaceProject(name){
  const r=await fsCall("switchWorkspaceProject",name);
  if(r.error)return false;
  state.projectName=name;
  SHELL.listing=null;SHELL.cwd=[];
  save();loadExtensions();render();
  return true;
}
async function createWorkspaceProject(name){
  const r=await fsCall("createWorkspaceProject",name);
  if(r.error)return {ok:false,error:r.result};
  state.projectName=name;
  SHELL.listing=null;SHELL.cwd=[];
  save();loadExtensions();render();
  return {ok:true};
}
window.__onProjectPicked=function(name){
  if(name){
    state.projectName=name;
    showBanner("Connected to project: "+name);
  }else{
    // User cancelled the picker: keep previous state, no fake "connected" notice.
  }
  SHELL.listing=null;SHELL.cwd=[];
  loadExtensions();
  render();
};
window.__onWorkspacePicked=function(name){
  if(name){
    state.wsEnabled=true;
    showBanner("Workspace: "+name);
  }
  updateWorkspaceUI();
  save();
  loadExtensions();
};
function updateWorkspaceUI(){
  const st=$("workspaceStatus");if(!st)return;
  const has=window.Android&&Android.hasWorkspace&&Android.hasWorkspace();
  st.innerHTML=has?"📁 "+esc(Android.getWorkspaceName()):"Not set";
  st.classList.toggle("on",!!has);
  $("wsEnabled").checked=state.wsEnabled;
  $("wsPick").style.display=state.wsEnabled?"":"none";
  $("wsClear").style.display=has?"":"none";
}
window.__onFilesPicked=function(files){
  if(!files||!files.length)return;
  for(const f of files){
    const isImage=/\.(png|jpe?g|webp|gif)$/i.test(f.name);
    if(isImage){
      const mime=guessMime(f.name);
      state.attachments.push({name:f.name,kind:"image",data:f.b64,dataUrl:`data:${mime};base64,${f.b64}`});
    }else{
      state.attachments.push({name:f.name,kind:"text",data:f.b64});
    }
  }
  renderAttachments();
};
function initProjectState(){
  if(window.Android&&Android.hasProject&&Android.hasProject()){
    state.projectName=Android.getProjectName?Android.getProjectName():"project";
  }else{
    state.projectName=localStorage.getItem("projectName")||"";
  }
}
/* ── Recent chats: persisted per session ── */
function getChats(){try{return JSON.parse(localStorage.getItem("chats")||"[]")}catch(e){return[]}}
function setChats(chats){
  try{localStorage.setItem("chats",JSON.stringify(chats))}
  catch(e){
    // Quota: drop oldest chats until it fits (attachments are already stripped).
    while(chats.length>1){chats.pop();try{localStorage.setItem("chats",JSON.stringify(chats));return}catch(_){}}
  }
}
/* Skip generic greeting-only openers when picking the chat title — "привет"
   repeated across every chat isn't useful for finding a chat by eyeballing. */
const GREETING_RE=/^(привет|здравствуй\w*|хай|hi|hello|hey|yo)[\s.,!?]*$/i;
function chatTitleFrom(msgs){
  const userMsgs=msgs.filter(m=>m.role==="user"&&m.text&&m.text.trim());
  let src=userMsgs[0];
  if(src&&GREETING_RE.test(src.text.trim())&&userMsgs[1])src=userMsgs[1];
  let t=String((src||{}).text||"Chat").replace(/[\n\r]+/g," ").trim();
  if(t.length>44){
    const cut=t.slice(0,44);
    const lastSpace=cut.lastIndexOf(" ");
    t=(lastSpace>20?cut.slice(0,lastSpace):cut).trim()+"…";
  }
  return t;
}
function saveCurrentChat(){
  if(!state.messages.length)return;
  const chats=getChats();
  const sid=currentSessionId();
  const stripAttachments=a=>(a||[]).map(x=>({name:x.name,kind:x.kind}));
  const record={
    id:sid,
    title:chatTitleFrom(state.messages),
    updatedAt:Date.now(),
    summary:state.summary,
    // Strip base64/dataUrl payloads — only names/kinds survive in the list.
    messages:state.messages.map(m=>({...m,attachments:stripAttachments(m.attachments)})),
    // Full branch tree, not just the active path — switching variants after
    // reloading a saved chat needs the abandoned branches to still exist.
    tree:{
      rootId:state.tree.rootId,
      nodes:Object.fromEntries(Object.entries(state.tree.nodes).map(([id,n])=>
        [id,{...n,attachments:stripAttachments(n.attachments)}]))
    }
  };
  const idx=chats.findIndex(c=>c.id===sid);
  if(idx>=0)chats[idx]=record;else chats.unshift(record);
  setChats(chats);
}
function formatChatTime(ts){
  const d=new Date(ts),now=new Date();
  if(d.toDateString()===now.toDateString())return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  return d.toLocaleDateString([],{day:"numeric",month:"short"});
}
function loadChat(id){
  const c=getChats().find(x=>x.id===id);if(!c)return;
  if(c.tree&&c.tree.nodes){
    state.tree={rootId:c.tree.rootId,nodes:c.tree.nodes};
  }else{
    // Legacy chat saved before branching existed: wrap the flat list into a
    // trivial linear tree (no branches) — lossless, computePath() reproduces
    // the exact original order.
    state.tree={rootId:null,nodes:{}};
    let parentId=null;
    for(const m of (c.messages||[])){
      state.tree.nodes[m.id]={...m,parentId,children:[],activeChildId:null};
      if(parentId){
        const p=state.tree.nodes[parentId];
        p.children.push(m.id);p.activeChildId=m.id;
      }else{
        state.tree.rootId=m.id;
      }
      parentId=m.id;
    }
  }
  state.messages=computePath();
  state.summary=c.summary||"";state.attachments=[];state.lastUsage=null;
  localStorage.setItem("currentSession",id);
  save();render();renderAttachments();renderCtxRing();
  $("closeDrawer").click();
}
function renderRecent(){
  const box=$("recent");if(!box)return;
  const q=($("chatSearch")&&$("chatSearch").value||"").trim().toLowerCase();
  let chats=getChats().sort((a,b)=>b.updatedAt-a.updatedAt);
  if(q)chats=chats.filter(c=>
    (c.title||"").toLowerCase().includes(q)||
    (c.messages||[]).some(m=>(m.text||"").toLowerCase().includes(q))
  );
  if(!chats.length){
    box.innerHTML=q
      ?`<div class="recent-empty"><svg><use href="#i-chat"/></svg>No chats match "${esc(q)}"</div>`
      :'<div class="recent-empty"><svg><use href="#i-chat"/></svg>No saved chats yet</div>';
    return;
  }
  const now=Date.now(),oneDay=86400000;
  const startOfToday=new Date();startOfToday.setHours(0,0,0,0);
  const today=startOfToday.getTime(),yesterday=today-oneDay,week=today-6*oneDay;
  const groups=[["Today",c=>c.updatedAt>=today],["Yesterday",c=>c.updatedAt>=yesterday&&c.updatedAt<today],["Previous 7 days",c=>c.updatedAt>=week&&c.updatedAt<yesterday],["Older",c=>c.updatedAt<week]];
  let html="";
  for(const [label,test] of groups){
    const items=chats.filter(test);
    if(!items.length)continue;
    html+=`<div class="muted-label">${label}</div>`;
    html+=items.map(c=>`<button class="recent-chat" onclick="loadChat('${c.id}')"><span class="chat-dot"></span><span class="recent-chat-main"><span class="recent-chat-title">${esc(c.title)}</span><span class="recent-chat-time">${formatChatTime(c.updatedAt)}</span></span></button>`).join("");
  }
  box.innerHTML=html;
}
/* ── Branching message tree ──────────
   state.tree is the source of truth; state.messages is always recomputed
   from it as the flat "currently active path" (parent -> activeChildId ->
   ... until a node has none). Everything else in the app (render, send's
   history builder, persistence, search, compaction) reads state.messages
   and never needs to know branches exist. */
function computePath(){
  const {rootId,nodes}=state.tree;
  const path=[];
  let cur=rootId?nodes[rootId]:null;
  while(cur){path.push(cur);cur=cur.activeChildId?nodes[cur.activeChildId]:null}
  return path;
}
function addMessage(role,text,attachments=[]){
  const id=crypto.randomUUID?crypto.randomUUID():String(Date.now());
  const node={id,role,text,attachments,ts:Date.now(),parentId:null,children:[],activeChildId:null};
  const parent=state.messages[state.messages.length-1]||null;
  state.tree.nodes[id]=node;
  if(parent){
    node.parentId=parent.id;
    const parentNode=state.tree.nodes[parent.id];
    parentNode.children.push(id);
    parentNode.activeChildId=id;
  }else{
    state.tree.rootId=id;
  }
  state.messages=computePath();
  save();saveCurrentChat();render();
  fireExt("message",{role,text});
  return id;
}
function renderAttachments(){
  $("attachments").innerHTML=state.attachments.map((a,i)=>{
    const thumb=a.kind==="image"&&a.dataUrl?`<img src="${a.dataUrl}">`:'<svg><use href="#i-file"/></svg>';
    return `<div class="attachment">${thumb}<span>${esc(a.name)}</span><button onclick="removeAttachment(${i})" aria-label="Remove"><svg><use href="#i-close"/></svg></button></div>`;
  }).join("");
}
function removeAttachment(i){state.attachments.splice(i,1);renderAttachments()}
function editMessage(idx){
  const m=state.messages[idx];
  if(!m||m.role!=="user")return;
  // Editing re-opens the prompt for revision: drop this turn and everything
  // after it (the old assistant answer no longer matches), same as retry
  // used to. Unlike retry, edits don't branch yet — dead-end the active path
  // at this node's parent so state.messages stays in sync with the tree
  // (the trimmed nodes still exist in state.tree.nodes, just unreachable).
  const node=state.tree.nodes[m.id];
  if(node&&node.parentId)state.tree.nodes[node.parentId].activeChildId=null;
  else state.tree.rootId=null;
  state.messages=computePath();
  save();saveCurrentChat();render();
  $("input").value=m.text||"";
  resizeInput();
  $("input").focus();
}
function switchVariant(nodeId,direction){
  const node=state.tree.nodes[nodeId];
  if(!node)return;
  if($("sendBtn").classList.contains("stop"))return; // no switching mid-stream
  const parent=node.parentId?state.tree.nodes[node.parentId]:null;
  if(!parent)return; // root has no siblings in this pass
  const siblings=parent.children;
  const newI=siblings.indexOf(nodeId)+direction;
  if(newI<0||newI>=siblings.length)return;
  parent.activeChildId=siblings[newI];
  state.messages=computePath();
  save();saveCurrentChat();render();
}
function retryMessage(idx){
  const m=state.messages[idx];
  if(!m||m.role!=="assistant")return;
  const node=state.tree.nodes[m.id];
  if(!node||!node.parentId)return;
  const parent=state.tree.nodes[node.parentId];
  // Create an empty sibling shell under the same parent, switch the active
  // path to it, and let send() fill it in as the regenerated answer streams
  // in. The old branch (this answer plus anything built on top of it) stays
  // fully intact in state.tree.nodes — just no longer on the active path.
  const newId=crypto.randomUUID?crypto.randomUUID():String(Date.now());
  state.tree.nodes[newId]={id:newId,role:"assistant",text:"",attachments:[],ts:Date.now(),parentId:parent.id,children:[],activeChildId:null};
  parent.children.push(newId);
  parent.activeChildId=newId;
  state.messages=computePath();
  save();saveCurrentChat();render();
  send(REGEN,newId);
}
function openFiles(){
  if(window.Android&&Android.openFilePicker)Android.openFilePicker();
  else alert("File picker is available in the Android app.");
  closeSheets();
}
function openSheet(id){
  closeSheets();
  $(id).classList.add("open");
  $("sheetScrim").classList.add("open");
}
function closeSheets(){
  document.querySelectorAll(".sheet").forEach(s=>s.classList.remove("open"));
  $("sheetScrim").classList.remove("open");
}
function provider(id){
  id=id.toLowerCase();
  if(id.includes("claude")||id.includes("anthropic"))return"anthropic";
  if(id.includes("gpt")||id.includes("openai"))return"openai";
  if(id.includes("gemini"))return"google";
  if(id.includes("qwen"))return"qwen";
  if(id.includes("glm")||id.includes("zai"))return"zai";
  if(id.includes("deepseek"))return"deepseek";
  if(id.includes("llama"))return"meta";
  if(id.includes("mistral"))return"mistral";
  if(id.includes("grok"))return"xai";
  return"custom";
}
function renderModels(){
  const box=$("models");
  if(!state.models.length){box.innerHTML='<div class="empty-models">No models loaded.<br>Add a Base URL and API key in Settings.</div>';return}
  box.innerHTML=state.models.map(m=>{
    const p=m.provider||provider(m.id);
    const sel=m.id===state.selected;
    const ctx=state.modelContext&&state.modelContext[m.id];
    return `<button class="model-item ${sel?"selected":""}" onclick="selectModel('${encodeURIComponent(m.id)}')">
      <div class="model-icon p-${p}">${esc(p[0].toUpperCase())}</div>
      <div class="model-main"><div class="model-name">${esc(m.name||m.id)}</div><div class="model-provider">${esc(p)}</div></div>
      <div class="model-end">
        ${ctx?`<span class="ctx-badge" title="Custom context settings">${fmtTokens(ctx.input)}/${fmtTokens(ctx.output)}</span>`:""}
        ${sel?'<span class="row-arrow"><svg><use href="#i-check"/></svg></span>':""}
      </div>
    </button>`;
  }).join("");
}
function updateModelBtn(){$("modelBtn").textContent=state.selected||"Model"}
function fmtTokens(n){
  n=Number(n)||0;
  if(n>=1000)return Math.round(n/1000)+"k";
  return String(n);
}
/* Effective context/output limits: per-model override wins, global defaults otherwise. */
function getCtxLimits(){
  const ov=state.modelContext&&state.selected?state.modelContext[state.selected]:null;
  return ov?{input:ov.input,output:ov.output}:state.settings;
}
function isModelOverridden(){
  return !!(state.modelContext&&state.selected&&state.modelContext[state.selected]);
}
/* Latest usage numbers straight from the API (message_start/message_delta),
   not an estimate — Anthropic reports real input/output/cache token counts. */
function updateUsage(u,isDelta){
  if(!state.lastUsage)state.lastUsage={};
  const cur=state.lastUsage;
  if(u.input_tokens!=null)cur.input=u.input_tokens;
  if(u.output_tokens!=null)cur.output=u.output_tokens;
  if(u.cache_read_input_tokens!=null)cur.cacheRead=u.cache_read_input_tokens;
  if(u.cache_creation_input_tokens!=null)cur.cacheCreation=u.cache_creation_input_tokens;
  cur.updatedAt=Date.now();
  save();
  renderCtxRing();
}
function renderCtxRing(){
  const btn=$("ctxRingBtn"),fg=$("ctxRingFg"),label=$("ctxRingLabel");
  if(!btn||!fg||!label)return;
  const lim=getCtxLimits();
  const limit=Number(lim.input)||128000;
  const u=state.lastUsage||{};
  const used=(Number(u.input)||0)+(Number(u.cacheRead)||0)+(Number(u.cacheCreation)||0)+(Number(u.output)||0);
  const pct=Math.max(0,Math.min(100,Math.round((used/limit)*100)));
  const C=81.68;
  fg.style.strokeDashoffset=String(C-(C*pct/100));
  label.textContent=pct+"%";
  btn.classList.toggle("warn",pct>=75&&pct<92);
  btn.classList.toggle("danger",pct>=92);
}
function renderUsagePanel(){
  const ring=$("usageRingFg"),pctEl=$("usageRingPct"),ringWrap=ring&&ring.closest(".usage-ring-big");
  const usedEl=$("usageUsed"),limitEl=$("usageLimit"),bd=$("usageBreakdown");
  if(!ring||!usedEl||!limitEl||!bd)return;
  const lim=getCtxLimits();
  const limit=Number(lim.input)||128000;
  const u=state.lastUsage||{};
  const input=Number(u.input)||0,output=Number(u.output)||0;
  const cacheRead=Number(u.cacheRead)||0,cacheCreation=Number(u.cacheCreation)||0;
  const used=input+output+cacheRead+cacheCreation;
  const pct=Math.max(0,Math.min(100,Math.round((used/limit)*100)));
  const C=169.6;
  ring.style.strokeDashoffset=String(C-(C*pct/100));
  pctEl.textContent=pct+"%";
  if(ringWrap){ringWrap.classList.toggle("warn",pct>=75&&pct<92);ringWrap.classList.toggle("danger",pct>=92)}
  usedEl.textContent=fmtTokens(used);
  limitEl.textContent=fmtTokens(limit);
  const rows=[];
  if(input)rows.push(["Last input",input]);
  if(output)rows.push(["Last output",output]);
  if(cacheRead)rows.push(["Cache read",cacheRead]);
  if(cacheCreation)rows.push(["Cache write",cacheCreation]);
  bd.innerHTML=rows.length
    ?rows.map(([k,v])=>`<div class="usage-bd-row"><span>${k}</span><b>${fmtTokens(v)}</b></div>`).join("")
    :'<div class="usage-bd-empty">No usage data yet — send a message</div>';
}
function selectModel(id){state.selected=decodeURIComponent(id);save();updateModelBtn();renderCtxRing();closeSheets()}
async function fetchModels(closeOnSuccess=false){
  $("settingsError").textContent="";
  if(!state.base){$("settingsError").textContent="Base URL is empty.";return}
  try{
    const r=await httpFetch("GET",state.base.replace(/\/$/,"")+"/v1/models",{"x-api-key":state.key,"anthropic-version":"2023-06-01"});
    if(r.error)throw Error("Network: "+r.body.slice(0,300));
    if(r.status<200||r.status>=300)throw Error(r.body.slice(0,600));
    const data=JSON.parse(r.body).data||[];
    state.models=data.map(x=>({id:x.id,name:x.display_name||x.id,provider:provider(x.id)}));
    if(!state.selected&&state.models[0])state.selected=state.models[0].id;
    save();renderModels();updateModelBtn();
    if(closeOnSuccess)closeSheets();
  }catch(e){$("settingsError").textContent=e.message||"Refresh failed"}
}
// Writes a completed/partial assistant reply into an existing tree node
// (retry's pre-created shell) instead of always appending a new one — the
// caller passes targetId only on the retry path.
function commitAssistantReply(text,targetId){
  if(targetId){
    const node=state.tree.nodes[targetId];
    node.text=text;node.ts=Date.now();
    state.messages=computePath();
    return node;
  }
  const id=addMessage("assistant",text,[]);
  return state.tree.nodes[id];
}
async function send(override,targetId){
  const input=$("input");
  const regen=override===REGEN;
  const prompt=regen?"":(typeof override==="string"?override:input.value).trim();
  // Slash commands never reach the model: intercept before the settings guard
  // so /help etc. work even without a configured API.
  if(!regen&&prompt.startsWith("/")){
    input.value="";resizeInput();
    $("slashMenu").classList.remove("show");
    await handleSlash(prompt);
    return;
  }
  if(!regen&&!prompt&&!state.attachments.length)return;
  if(regen&&!state.messages.length)return;
  if(!state.base||!state.key||!state.selected){openSheet("settingsSheet");$("baseUrl").value=state.base;$("apiKey").value=state.key;return}
  const at=[...state.attachments];
  input.value="";resizeInput();state.attachments=[];renderAttachments();
  if(!regen)addMessage("user",prompt,at);
  $("sendBtn").classList.add("stop");
  showTyping();
  const started=Date.now();
  // ---- Agent turn bracket: keep the FGS alive for the WHOLE turn (stream +
  // tool execution + pauses), not just one HTTP request. Without this the
  // process went cached between tool calls ￢ﾀﾔ the freezer killed live SSH
  // sockets and the WebView died mid-tool ("network dropped" while minimized).
  const bridge=window.Android;
  try{bridge&&bridge.agentTurnBegin()}catch(e){}
  let draftTimer=null;const DRAFT_KEY="turnDraft";
  const clearDraft=()=>{try{localStorage.removeItem(DRAFT_KEY)}catch(e){}};
  // Persist the in-flight turn (thinking + text + tool cards) on every change:
  // a crash/app-kill must never eat the reasoning the user watched stream.
  const writeDraft=()=>{
    try{
      const draft={text:(final+"\n\n"+turnText).trim(),thinking:allThinking,tools:toolCalls,ts:Date.now()};
      localStorage.setItem(DRAFT_KEY,JSON.stringify(draft));
    }catch(e){}
  };
  const schedDraft=()=>{clearTimeout(draftTimer);draftTimer=setTimeout(writeDraft,400)};
  try{
    compactIfNeeded();
    // History must never contain thinking blocks — models reject foreign tags on the way back.
    const THINK_STRIP=[["think","think"],["thinking","thinking"],["reasoning","reasoning"],["thought","thought"]];
    const strip=t=>{
      let s=String(t||"");
      for(const [open,close] of THINK_STRIP){
        s=s.replace(new RegExp(`<${open}(\\s[^>]*)?>[\s\S]*?</${close}(\s[^>]*)?>`,"gi"),"");
        s=s.replace(new RegExp(`</?${open}(\\s[^>]*)?>`,"gi"),"");
      }
      return s.trim();
    };
    // History: everything before the current turn, text-only (attachments were sent in their own turns).
    // A retry (regen with a targetId) leaves an empty assistant shell as the
    // last path entry — the real prompt to regenerate from is that shell's
    // user parent, one step further back, not state.messages' last element.
    const lastMsg=regen&&targetId
      ?state.messages[state.messages.length-2]
      :state.messages[state.messages.length-1];
    const historySlice=regen&&targetId?state.messages.slice(0,-2):state.messages.slice(0,-1);
    const history=historySlice
      .map(m=>({role:m.role,content:strip(m.text)}))
      .filter(m=>m.content);
    const messages=[];
    for(const m of history){
      const prev=messages[messages.length-1];
      if(prev&&prev.role===m.role){prev.content+="\n\n"+m.content}  // merge adjacent same-role turns
      else messages.push(m);
    }
    messages.push({role:"user",content:regen?buildUserContent(lastMsg.text,lastMsg.attachments||[]):buildUserContent(prompt,at)});
    const proj=hasProject();
    const ws=hasWorkspace();
    const system=(proj
      ?"You are NightCode, a local AI coding agent. You have tools to inspect and edit the user's selected project, but do NOT use them proactively — only call a tool when the user's message actually asks for something that requires it (reading, writing, searching, running code). A greeting or general question gets a plain reply with no tool calls. Be concise. Inspect files before changing them. Use write_file for actual edits. Do not claim a change was made unless the tool succeeded. Use web_search whenever fresh information would help (docs, versions, errors)."
      :ws
      ?"You are NightCode, a local AI coding agent. No project is currently open, but a projects folder is connected — do NOT use file tools proactively, only when the user's message actually asks for it. If the user asks you to build/create something new, first call create_directory with a short kebab-case name for the new project (e.g. \"my-app\"), then create all its files as paths INSIDE that directory (e.g. \"my-app/index.html\") — never write files directly at the root. If the user instead refers to continuing/opening an existing project, tell them to pick it from Projects in the menu; you cannot switch projects yourself. Be concise. Use web_search whenever fresh information would help."
      :"You are NightCode, a helpful AI assistant. There is no project folder connected, so do not assume access to local files. You have the web_search tool — use it only when the user's question actually needs current information; do not search proactively on greetings or general chat. Cite source URLs when you do search.")
      +(sshToolsAvailable()?" An SSH server is configured: use ssh_exec to run commands on it, ssh_upload to copy project files to it, ssh_download to fetch remote files. Destructive commands (rm -rf, service restarts, package removal) require explicit user confirmation first.":"")
      +(ghToolsAvailable()?" GitHub is authenticated: use github_api for repositories, files (GET /repos/{owner}/{repo}/contents/{path}), issues, PRs, releases and search as the user.":"")
      +(state.summary?`\nConversation summary:\n${state.summary}\nContinue the same conversation.`:"");
    let final="";const toolCalls=[];let allThinking="";
    // In-flight turn text: `final` only fills after a CLEAN turn end, so a
    // mid-stream death (socket killed while backgrounded) used to lose the
    // visible answer. This buffer always holds the current turn's partial.
    let turnText="";
    let liveCard=null;
    // Live answer bubble: text tokens render in place as they stream, so the
    // answer appears WHILE the model works — not as one lump at the very end.
    let liveBubble=null,liveBubbleText=null;
    const ensureLiveBubble=()=>{
      if(liveBubble)return;
      const chat=$("chat");
      const wrap=document.createElement("div");wrap.className="message assistant";
      wrap.innerHTML='<div class="bubble"><span id="liveText"></span><span class="stream-caret"></span></div>';
      chat.appendChild(wrap);
      liveBubble=wrap;liveBubbleText=document.getElementById("liveText");
      autoScroll();
    };
    const hideLiveBubble=()=>{if(liveBubble){liveBubble.remove();liveBubble=null;liveBubbleText=null}};
    const ensureLiveCard=()=>{
      if(liveCard)return;
      removeTyping();
      const chat=$("chat");
      liveCard=document.createElement("details");
      liveCard.className="tool-activity compact reasoning-card";
      liveCard.open=true;
      liveCard.innerHTML='<summary class="tool-activity-head"><div class="tool-activity-icon sm"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a4.5 4.5 0 0 0-4.5 4.5c0 .7.2 1.4.5 2A4 4 0 0 0 5 13.5 4 4 0 0 0 9 17.5h.5A3.5 3.5 0 0 0 12 20a3.5 3.5 0 0 0 2.5-2.5H15a4 4 0 0 0 4-4 4 4 0 0 0-3-3.8c.3-.6.5-1.3.5-2A4.5 4.5 0 0 0 12 3z"/></svg></div><div class="tool-activity-text"><div class="tool-activity-title" id="liveTitle">Thinking…</div></div><div class="tool-activity-status"><span class="tool-spinner"></span></div></summary><div class="tool-preview"><pre id="liveBody"></pre></div>';
      const wrap=document.createElement("div");wrap.className="message assistant";
      wrap.appendChild(liveCard);
      chat.appendChild(wrap);
      autoScroll();
    };
    const hideLiveCard=()=>{if(liveCard){liveCard.closest(".message").remove();liveCard=null}};
    _hideLiveCardFn=()=>{hideLiveCard();hideLiveBubble()};
    for(let turn=0;turn<8;turn++){
      if(turn>0)schedDraft();  // tool results landed ￢ﾀﾔ snapshot before next stream
      const lim=getCtxLimits();
      const body={model:state.selected,max_tokens:Number(lim.output)||6000,system,messages,stream:true};
      // Web tools always available; file tools with a connected project OR a
      // workspace folder (so the model can create a new project inside it).
      const webTools=(state.searchProvider!=="free"&&state.ollamaKey)?[WEB_SEARCH_TOOL,WEB_FETCH_TOOL]:[WEB_SEARCH_TOOL];
      // Extension tools ride along in every mode — they may not need a project.
      // SSH tools appear only when a connection is configured, so the model
      // isn't tempted to use them against nothing.
      body.tools=[...((proj||hasWorkspace())?FILE_TOOLS:[]),...webTools,...(sshToolsAvailable()?SSH_TOOLS:[]),...(ghToolsAvailable()?[GITHUB_TOOL]:[]),...extToolDefs()];
      const reqUrl=state.base.replace(/\/$/,"")+"/v1/messages";
      // Full SSE parser: collects thinking, text AND tool_use blocks straight from
      // the stream (content_block_start carries id/name, input_json_delta carries
      // the input JSON). No second non-streaming request — that re-generation was
      // slow and providers cut it off on long answers.
      const blocks={};          // index -> {type,id,name,inputJson}
      let stopReason=null;
      turnText="";
      const data={content:[]};
      const r=await withRetry(()=>httpStream("POST",reqUrl,{"content-type":"application/json","x-api-key":state.key,"anthropic-version":"2023-06-01"},JSON.stringify(body),chunk=>{
        try{
          const ev=JSON.parse(chunk);
          const tt=document.getElementById("liveTitle");
          if(ev.type==="message_start"){
            // A retry attempt re-streams the WHOLE message from scratch:
            // drop stale accumulators or the next attempt would duplicate
            // every delta the failed attempt already delivered.
            for(const k in blocks)delete blocks[k];
            turnText="";allThinking="";
            const u=(ev.message||{}).usage;
            if(u)updateUsage(u);
          }
          if(ev.type==="content_block_start"){
            const b=ev.content_block||{};
            blocks[ev.index]={type:b.type,id:b.id,name:b.name,inputJson:""};
            if(b.type==="tool_use"&&tt)tt.textContent="Running tool: "+(b.name||"");
          }
          if(ev.type==="content_block_delta"){
            const d=ev.delta||{};
            if(d.thinking){
              if(blocks[ev.index])blocks[ev.index].thinking=(blocks[ev.index].thinking||"")+d.thinking;
              ensureLiveCard();allThinking+=d.thinking;
              const tb=document.getElementById("liveBody");
              if(tb){tb.textContent=allThinking.slice(-3000);tb.scrollTop=tb.scrollHeight}
              autoScroll();
              schedDraft();
            }
            if(d.text){
              if(blocks[ev.index])blocks[ev.index].text=(blocks[ev.index].text||"")+d.text;
              turnText+=d.text;
              removeTyping();
              if(liveCard&&tt)tt.textContent="Writing…";
              ensureLiveBubble();
              if(liveBubbleText){liveBubbleText.textContent+=d.text;if(liveBubbleText.textContent.length>4000)liveBubbleText.textContent=liveBubbleText.textContent.slice(-4000)}
              autoScroll();
              schedDraft();
            }
            if(d.partial_json&&blocks[ev.index])blocks[ev.index].inputJson+=d.partial_json;
          }
          if(ev.type==="message_delta"&&ev.delta&&ev.delta.stop_reason)stopReason=ev.delta.stop_reason;
          if(ev.type==="message_delta"&&ev.usage)updateUsage(ev.usage,true);
          if(ev.type==="error")stopReason="error:"+((ev.error||{}).message||"stream error");
        }catch(e){console.log("[NightCode] chunk handler error "+String(e&&e.message||e))}
      }));
      if(r.cancelled){
        hideLiveCard();
        const partial=(final.trim()+"\n\n"+turnText.trim()).trim();
        const lm=commitAssistantReply(partial||"⏹ Generation stopped.",targetId);
        if(allThinking)lm.thinking=allThinking;
        lm.reasoning=Date.now()-started;save();render();
        return;
      }
      if(r.error){
        const friendly=netErrMsg(r.errMsg||r.body);
        throw Error(friendly||("Network: "+String(r.errMsg||r.body).slice(0,1000)));
      }
      if(r.status<200||r.status>=300){
        console.log("[NightCode] stream failed after retries "+JSON.stringify({status:r.status,errMsg:String(r.errMsg||"").slice(0,500),finalLen:final.length,thinkingLen:allThinking.length}));
        // Keep whatever streamed in: show partial thinking instead of dropping it.
        if(final||allThinking){
          hideLiveCard();
          const partial=(final.trim()+"\n\n"+turnText.trim()).trim();
          const lm=commitAssistantReply(partial||"⚠️ Поток оборвался после размышлений (HTTP "+r.status+"). Попробуй ещё раз.",targetId);
          if(allThinking)lm.thinking=allThinking;
          lm.reasoning=Date.now()-started;save();render();
          return;
        }
        hideLiveCard();
        throw Error("HTTP "+r.status+": "+String(r.errMsg||"").slice(0,500));
      }
      // Assemble Anthropic-style content from the streamed blocks.
      const content=[];
      for(const idx of Object.keys(blocks).map(Number).sort((a,b)=>a-b)){
        const b=blocks[idx];
        if(b.type==="text")content.push({type:"text",text:b.text||""});
        else if(b.type==="thinking")content.push({type:"thinking",thinking:b.thinking||""});
        else if(b.type==="tool_use"){
          let parsed={};
          try{parsed=JSON.parse(b.inputJson||"{}")}catch(e){console.log("[NightCode] tool input parse fail "+String(e&&e.message||e))}
          content.push({type:"tool_use",id:b.id,name:b.name,input:parsed});
        }
      }
      // Text/thinking arrived as deltas, already accumulated in final/allThinking.
      const data2={content};
      hideLiveCard();
      console.log("[NightCode] stream complete "+JSON.stringify({stopReason,blocks:Object.keys(blocks).length,finalLen:final.length,thinkingLen:allThinking.length}));
      const toolUses=content.filter(x=>x.type==="tool_use");
      // Hidden reasoning arrives in different shapes depending on the backend:
      // Anthropic-style thinking already streamed into allThinking via deltas above —
      // only OpenAI-style reasoning_content (which arrives whole, not as deltas)
      // still needs to be picked up here, or it'd be duplicated.
      let reasoning="";
      for(const item of content){
        if(item.reasoning_content)reasoning+=item.reasoning_content+"\n";
      }
      const altMsg=data2.choices&&data2.choices[0]&&data2.choices[0].message;
      if(!reasoning&&altMsg&&altMsg.reasoning_content)reasoning=altMsg.reasoning_content;
      // Keep thinking and answer SEPARATE: no <think>-wrapping into one string.
      // Re-merging and re-splitting breaks whenever the reasoning itself contains
      // angle brackets or quotes — the reason thinking kept leaking into bubbles.
      const text=content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
      if(reasoning)allThinking+=(allThinking?"\n\n":"")+reasoning.trim();
      if(text)final+=(final?"\n\n":"")+text;
      turnText=""; // committed into final; buffer is for the next turn only
      if(!toolUses.length)break;
      messages.push({role:"assistant",content});
      const results=[];
      for(const u of toolUses){
        // Tool cards render INSIDE the live bubble, between text segments ￢ﾀﾔ
        // nothing disappears when a tool starts running (Claude Code style).
        const activity=showToolActivity(u.name,u.input||{},liveBubbleText);
        let out,err=false;
        try{
          const res=await runTool(u.name,u.input||{});
          out=res.result;err=res.error;
          activity.update(out,err);
        }catch(e){out=String(e.message||e);err=true;activity.update(out,true)}
        fireExt("tool",{name:u.name,input:u.input||{},result:String(out),error:err});
        toolCalls.push({name:u.name,input:u.input||{},result:String(out),error:err});
        schedDraft();
        results.push({type:"tool_result",tool_use_id:u.id,is_error:err,content:String(out)});
      }
      messages.push({role:"user",content:results});
      showTyping();
    }
    removeTyping();
    hideLiveBubble();
    // When the model burns its whole budget on thinking and returns no text,
    // surface an honest explanation instead of a dead "(empty response)" bubble.
    const finalText=final.trim()||"Модель не дала текстового ответа — возможно, лимит токенов исчерпан на размышления или тулах. Попробуй ещё раз или упрости запрос.";
    const last=commitAssistantReply(finalText,targetId);
    last.reasoning=Date.now()-started;
    if(allThinking.trim())last.thinking=allThinking.trim();
    if(toolCalls.length){
      last.tools=toolCalls;
      // Canonical block transcript: [{text},{tool},{text},...]. The "final"
      // text is the LAST block; earlier text segments stay where they streamed.
      const bl=[];
      for(const t of toolCalls)bl.push({tool:t});
      bl.push({text:finalText});
      last.blocks=bl;
    }
    clearDraft();
    save();render();
  }catch(e){
    removeTyping();
    _hideLiveCardFn&&_hideLiveCardFn();
    console.error("[NightCode] send failed "+JSON.stringify({name:e&&e.name,message:String(e&&e.message||e).slice(0,1500),stack:String(e&&e.stack||"").slice(0,800)}));
    // If the model streamed any thinking/text before dying, keep it visible
    // instead of letting it vanish with the live card.
    // Rebuild the partial from committed text + in-flight buffer: deltas only
    // reach `final` after a clean turn end, so a mid-stream crash used to
    // commit an empty answer and the visible text vanished.
    const pFinal=(typeof final!=='undefined')?final.trim():"";
    const pTurn=(typeof turnText!=='undefined')?turnText.trim():"";
    const streamedPartial=(pFinal+(pFinal&&pTurn?"\n\n":"")+pTurn).trim();
    if((typeof allThinking!=='undefined'&&allThinking)||streamedPartial){
      const lm=commitAssistantReply(streamedPartial||"⚠️ "+(e.message||e),targetId);
      if(typeof allThinking!=='undefined'&&allThinking)lm.thinking=allThinking;
      lm.reasoning=Date.now()-started;save();render();
    }else{
      commitAssistantReply("Error: "+(e.message||e),targetId);
    }
  }
  finally{
    $("sendBtn").classList.remove("stop");hideLiveCardSafe();
    clearTimeout(draftTimer);
    try{bridge&&bridge.agentTurnEnd()}catch(e){}
  }
}
let _hideLiveCardFn=null;
function hideLiveCardSafe(){if(_hideLiveCardFn)_hideLiveCardFn()}
function compactIfNeeded(){
  if(!state.settings.auto)return;
  const lim=getCtxLimits();
  const estimate=state.messages.reduce((n,m)=>n+(m.text||"").length,0)/4;
  if(estimate>Number(lim.input)*Number(state.settings.threshold)/100)compactNow(false);
}
function compactNow(show=true){
  if(state.messages.length<8){if(show)alert("Not enough messages to compact.");return}
  const old=state.messages.slice(0,-4).map(m=>`${m.role}: ${(m.text||"").slice(0,900)}`).join("\n");
  state.summary=(state.summary+"\n"+old).slice(-12000);
  // Same visible effect as the old state.messages.slice(-4) truncation, but
  // done by re-rooting the tree at the cutoff node instead of mutating the
  // derived array directly — the trimmed-off nodes stay intact in
  // state.tree.nodes (unreachable from the new root, not deleted).
  const cutoff=state.messages[state.messages.length-4];
  state.tree.nodes[cutoff.id].parentId=null;
  state.tree.rootId=cutoff.id;
  state.messages=computePath();
  save();render();if(show)closeSheets();
}
function b64ToText(b64){
  try{
    const bin=atob(b64);
    const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    return new TextDecoder("utf-8",{fatal:false}).decode(bytes);
  }catch(e){return ""}
}
function guessMime(name){
  const ext=(name.split(".").pop()||"").toLowerCase();
  return ({jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif"}[ext])||"image/png";
}
function buildUserContent(prompt,attachments){
  const content=[];
  if(prompt)content.push({type:"text",text:prompt});
  for(const a of attachments||[]){
    if(a.kind==="image"&&a.data){
      content.push({type:"image",source:{type:"base64",media_type:guessMime(a.name),data:a.data}});
    }else if(a.data){
      content.push({type:"text",text:"Attached file: "+a.name+"\n\n"+b64ToText(a.data).slice(0,50000)});
    }else{
      content.push({type:"text",text:"Attached file: "+a.name});
    }
  }
  return content;
}

/* ── Agent tool execution via Android FS bridge ── */
const FILE_TOOLS=[
  {name:"list_files",description:"List files in the connected project folder.",input_schema:{type:"object",properties:{},required:[]}},
  {name:"read_file",description:"Read a text file from the project.",input_schema:{type:"object",properties:{path:{type:"string"}},required:["path"]}},
  {name:"search_files",description:"Search text inside project files. Use this before editing to find symbols or references.",input_schema:{type:"object",properties:{query:{type:"string"},path:{type:"string"}},required:["query"]}},
  {name:"write_file",description:"Create or replace a text file in the project.",input_schema:{type:"object",properties:{path:{type:"string"},content:{type:"string"}},required:["path","content"]}},
  {name:"create_directory",description:"Create a directory in the project.",input_schema:{type:"object",properties:{path:{type:"string"}},required:["path"]}},
  {name:"rename_file",description:"Rename or move a file within the project.",input_schema:{type:"object",properties:{from:{type:"string"},to:{type:"string"}},required:["from","to"]}},
  {name:"delete_file",description:"Delete a file from the project. Only use when the user explicitly asks for deletion.",input_schema:{type:"object",properties:{path:{type:"string"}},required:["path"]}}
];
const WEB_SEARCH_TOOL={name:"web_search",description:"Search the web for current information: documentation, recent events, library APIs, error messages. Returns titles, snippets and URLs.",input_schema:{type:"object",properties:{query:{type:"string",description:"Search query"}},required:["query"]}};
const WEB_FETCH_TOOL={name:"web_fetch",description:"Fetch a web page by URL and return its main text content. Use after web_search to read a promising result in full before answering.",input_schema:{type:"object",properties:{url:{type:"string",description:"Full URL including https://"}},required:["url"]}};

/* Web search router: news-type queries go to Google News RSS (excellent Russian
   coverage, machine-readable), everything else to Bing RSS (stable, no captcha).
   httpFetch (native bridge) has no CORS limits. DDG Instant Answers is the
   last-resort fallback. */
function isNewsQuery(q){
  return /новост|событ|сегодня|свеж|последн|latest|news|today|this week|breaking|войн|выбор|election|war/i.test(q);
}
/* ── Ollama web search/fetch (https://docs.ollama.com/web-search) ── */
async function ollamaApi(path,payload){
  const key=state.ollamaKey;
  if(!key)return {error:true,body:"No Ollama API key set (Settings → Web search)"};
  const r=await httpFetch("POST","https://ollama.com/api/"+path,{"Authorization":"Bearer "+key,"content-type":"application/json"},JSON.stringify(payload));
  console.log("[NightCode] Ollama "+path+" "+JSON.stringify({status:r.status,error:r.error,bodyStart:(r.body||"").slice(0,300)}));
  return r;
}
/* Quick key check: a 1-result search. Called when the user saves the key. */
// verifyOllamaKey (UI version) lives with the settings handlers below.
async function searchOllama(q){
  const r=await ollamaApi("web_search",{query:q,max_results:8});
  if(r.error||r.status<200||r.status>=300)return null;
  try{
    const d=JSON.parse(r.body);
    const out=(d.results||[]).map((x,i)=>(i+1)+". "+(x.title||"")+(x.url?"\n   URL: "+x.url:"")+(x.content?"\n   "+String(x.content).replace(/\s+/g," ").trim():""));
    return out.length?out.join("\n\n").slice(0,6000):null;
  }catch(e){return null}
}
/* Heuristic: Bing RSS pads thin/irrelevant queries with unrelated sponsored noise
   (calculators, e-commerce). If query terms barely appear in the results, the
   result set is garbage — say so instead of feeding the model junk. */
function resultsRelevant(q,resultsText){
  const norm=s=>String(s||"").toLowerCase().replace(/ё/g,"е");
  const terms=norm(q).split(/[\s\"«»'’`?!,.()]+/).filter(t=>t.length>2);
  if(!terms.length)return true;
  const hay=norm(resultsText);
  let hits=0;
  for(const t of terms)if(hay.includes(t))hits++;
  return hits>=Math.max(1,Math.ceil(terms.length*0.4));
}
async function fetchOllama(url){
  const r=await ollamaApi("web_fetch",{url});
  if(r.error||r.status<200||r.status>=300)return {result:"FETCH_FAILED: "+r.body.slice(0,200),error:true};
  try{
    const d=JSON.parse(r.body);
    const text=(d.title?"# "+d.title+"\n\n":"")+(d.content||"");
    return {result:text.slice(0,12000)||"(empty page)",error:false};
  }catch(e){return {result:"FETCH_FAILED: bad response",error:true}}
}
async function searchGoogleNews(q){
  const strip=s=>String(s).replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+/g," ").trim();
  const r=await httpFetch("GET","https://news.google.com/rss/search?q="+encodeURIComponent(q)+"&hl=ru&gl=UA&ceid=UA:ru",{"User-Agent":"Mozilla/5.0 (Android 14; Mobile) Safari/537.3"});
  console.log("[NightCode] Google News "+JSON.stringify({status:r.status,error:r.error,bodyLength:(r.body||"").length}));
  if(r.error||r.status<200||r.status>=300||!r.body)return null;
  const items=[...r.body.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const out=[];
  for(const m of items){
    const title=(m[1].match(/<title>([\s\S]*?)<\/title>/)||[])[1]||"";
    const link=(m[1].match(/<link>([\s\S]*?)<\/link>/)||[])[1]||"";
    const date=(m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/)||[])[1]||"";
    const src=(m[1].match(/<source[^>]*>([\s\S]*?)<\/source>/)||[])[1]||"";
    if(title)out.push((out.length+1)+". "+strip(title)+(src?" — "+strip(src):"")+(date?" ("+strip(date)+")":"")+(link?"\n   URL: "+strip(link):""));
    if(out.length>=8)break;
  }
  return out.length?out.join("\n\n").slice(0,6000):null;
}
async function searchBing(q){
  const strip=s=>String(s).replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+/g," ").trim();
  const r=await httpFetch("GET","https://www.bing.com/search?q="+encodeURIComponent(q)+"&format=rss&count=8&setlang=ru",{"User-Agent":"Mozilla/5.0 (Android 14; Mobile) Safari/537.3","Accept-Language":"ru-RU,ru;q=0.9,en;q=0.8"});
  console.log("[NightCode] Bing RSS "+JSON.stringify({status:r.status,error:r.error,bodyLength:(r.body||"").length}));
  if(r.error||r.status<200||r.status>=300||!r.body)return null;
  const items=[...r.body.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const out=[];
  for(const m of items){
    const title=(m[1].match(/<title>([\s\S]*?)<\/title>/)||[])[1]||"";
    const link=(m[1].match(/<link>([\s\S]*?)<\/link>/)||[])[1]||"";
    const desc=(m[1].match(/<description>([\s\S]*?)<\/description>/)||[])[1]||"";
    if(title||link)out.push((out.length+1)+". "+strip(title)+(link?"\n   URL: "+strip(link):"")+(desc?"\n   "+strip(desc):""));
    if(out.length>=8)break;
  }
  return out.length?out.join("\n\n").slice(0,6000):null;
}
async function runWebSearch(query){
  const q=String(query||"").trim();
  if(!q)return {result:"EMPTY_QUERY",error:true};
  // Provider routing: explicit choice wins, auto = Ollama first when key exists.
  const prov=state.searchProvider||"auto";
  if(prov!=="free"&&state.ollamaKey){
    const o=await searchOllama(q);
    if(o)return {result:o,error:false};
    console.log("[NightCode] Ollama search empty, provider="+prov);
    if(prov==="ollama")return {result:"SEARCH_FAILED: Ollama returned no results",error:true};
  }
  const news=isNewsQuery(q);
  try{
    if(news){
      const g=await searchGoogleNews(q);
      if(g)return {result:g,error:false};
    }
    const b=await searchBing(q);
    if(b&&resultsRelevant(q,b))return {result:b,error:false};
    console.log("[NightCode] Bing results irrelevant for query, falling through");
    if(!news){
      const g=await searchGoogleNews(q);
      if(g)return {result:g,error:false};
    }
  }catch(e){console.log("[NightCode] web search fail "+String(e&&e.message||e))}
  try{
    const r=await httpFetch("GET","https://api.duckduckgo.com/?q="+encodeURIComponent(q)+"&format=json&no_html=1&skip_disambig=1",{"User-Agent":"Mozilla/5.0"});
    if(!r.error&&r.body){
      const strip=s=>String(s).replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
      const d=JSON.parse(r.body);
      const parts=[];
      if(d.Answer)parts.push("Answer: "+strip(d.Answer));
      if(d.AbstractText)parts.push(d.AbstractText+(d.AbstractURL?"\nSource: "+d.AbstractURL:""));
      for(const t of (d.RelatedTopics||[])){
        if(t.Text&&parts.length<8)parts.push(t.Text+(t.FirstURL?"\nURL: "+t.FirstURL:""));
      }
      if(parts.length)return {result:parts.join("\n\n").slice(0,6000),error:false};
    }
  }catch(e){}
  return {result:"SEARCH_FAILED: no results (network or parsing error)",error:true};
}
async function runTool(name,input){
  // Extension tools first: they may shadow nothing built-in, but win on unknown names.
  const et=EXT.tools.get(name);
  if(et){
    if(!extEnabled(et.ext))return {result:"TOOL_DISABLED (extension '"+et.ext+"' is off)",error:true};
    try{
      const r=await et.run(input||{});
      return r&&typeof r==="object"?r:{result:String(r),error:false};
    }catch(e){return {result:String(e&&e.message||e),error:true}}
  }
  if(name==="web_search")return runWebSearch(input.query);
  if(name==="web_fetch"){
    let url=String(input.url||"").trim();
    if(!/^https?:\/\//i.test(url))url="https://"+url.replace(/^\/+/,"");
    // MediaWiki sites (Fandom, Wikipedia, Miraheze): use the official API instead
    // of scraping HTML — ?action=raw redirects to 404 on Fandom, but api.php
    // serves clean wikitext. If the URL points at a /wiki/ page, parse it;
    // otherwise treat the query as a search across the wiki.
    try{
      const u=new URL(url);
      if(/(^|\.)fandom\.com$/.test(u.hostname)||/(^|\.)wikipedia\.org$/.test(u.hostname)||/(^|\.)miraheze\.org$/.test(u.hostname)){
        const api=u.origin+"/api.php";
        const wikiTitle=u.pathname.startsWith("/wiki/")?decodeURIComponent(u.pathname.slice(6)):"";
        if(wikiTitle){
          const pr=await httpFetch("GET",api+"?action=parse&page="+encodeURIComponent(wikiTitle)+"&prop=wikitext&format=json",{"User-Agent":"Mozilla/5.0 (Android 14; Mobile) Chrome/127"});
          if(!pr.error&&pr.body){
            try{
              const d=JSON.parse(pr.body);
              if(d.parse&&d.parse.wikitext){
                return {result:("URL: "+url+"\n\n"+d.parse.wikitext["*"]).slice(0,12000),error:false};
              }
              if(d.error&&d.error.code==="missingtitle"){
                return {result:"PAGE_NOT_FOUND: "+wikiTitle+" doesn't exist on this wiki. Search the wiki instead.",error:true};
              }
            }catch(e){}
          }
        }
        // Search the wiki by hostname prefix (e.g. geometry-dash-fan.fandom.com G2961)
        const mQuery=wikiTitle||u.searchParams.get("q")||"";
        const term=mQuery.split(/\s+/).filter(w=>!/fandom|wikipedia|miraheze|wiki|https?/i.test(w)).join(" ").trim();
        if(term){
          const sr=await httpFetch("GET",api+"?action=query&list=search&srsearch="+encodeURIComponent(term)+"&srlimit=8&format=json",{"User-Agent":"Mozilla/5.0 (Android 14; Mobile) Chrome/127"});
          if(!sr.error&&sr.body){
            try{
              const d=JSON.parse(sr.body);
              const hits=(d.query&&d.query.search)||[];
              if(hits.length){
                const lines=hits.map((h,i)=>(i+1)+". "+h.title+(h.wordcount?" ("+h.wordcount+" words)":"")+"\n   "+u.origin+"/wiki/"+encodeURIComponent(h.title));
                return {result:("WIKI SEARCH: "+term+"\n\n"+lines.join("\n")+"\n\nUse web_fetch on any /wiki/ URL to read the article.").slice(0,6000),error:false};
              }
            }catch(e){}
          }
        }
      }
    }catch(e){}
    if(state.searchProvider!=="free"&&state.ollamaKey){
      const of=await fetchOllama(url);
      if(!of.error)return of;
    }
    // Last resort: fetch raw HTML natively and strip tags.
    const r=await httpFetch("GET",url,{"User-Agent":"Mozilla/5.0 (Android 14; Mobile) Gecko/537.36 Chrome/127.0.0.0 Mobile Safari/537.36","Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"ru-RU,ru;q=0.9,en;q=0.8"});
    if(r.error||r.status<200||r.status>=300)return {result:"FETCH_FAILED: "+r.body.slice(0,200),error:true};
    const text=r.body
      .replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"")
      .replace(/<[^>]+>/g," ").replace(/&amp;/g,"&").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
    return {result:("URL: "+url+"\n\n"+text).slice(0,12000),error:false};
  }
  if(name==="list_files")return fsCall("fsList","");
  if(name==="ssh_exec"||name==="ssh_upload"||name==="ssh_download")return sshRunTool(name,input);
  if(name==="github_api")return ghRunTool(input);
  if(name==="read_file")return fsCall("fsRead",input.path);
  if(name==="search_files")return fsCall("fsSearch",input.query);
  if(name==="write_file")return fsCall("fsWrite",input.path,btoa(unescape(encodeURIComponent(String(input.content||"")))));
  if(name==="create_directory")return fsCall("fsMkdir",input.path);
  if(name==="rename_file")return fsCall("fsRename",input.from,input.to);
  if(name==="delete_file")return fsCall("fsDelete",input.path);
  return {result:"UNKNOWN_TOOL",error:true};
}
function hasProject(){
  return !!(window.Android&&Android.hasProject&&Android.hasProject());
}
function hasWorkspace(){
  return !!(window.Android&&Android.hasWorkspace&&Android.hasWorkspace());
}

/* ── Console: Shell over the connected folder + JS REPL + log viewer ── */
const CON={tab:"shell",welcomed:false,
  hist:{shell:JSON.parse(localStorage.getItem("ncHistShell")||"[]"),js:JSON.parse(localStorage.getItem("ncHistJs")||"[]"),ssh:JSON.parse(localStorage.getItem("ncHistSsh")||"[]")},
  hi:{shell:-1,js:-1,ssh:-1}};
const LOGBUF=[];
const MONO="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
(function patchConsole(){
  // Capture app logs so the Logs tab shows what logcat would — no ADB needed.
  const fmt=v=>typeof v==="string"?v:(()=>{try{return JSON.stringify(v)}catch(e){return String(v)}})();
  for(const level of ["log","info","warn","error"]){
    const orig=console[level]?console[level].bind(console):null;
    console[level]=function(...a){
      const entry={t:Date.now(),level,text:a.map(fmt).join(" ")};
      LOGBUF.push(entry);
      if(LOGBUF.length>400)LOGBUF.shift();
      if(CON.tab==="logs")coAppendLog(entry);
      orig&&orig(...a);
    };
  }
})();
function coPrint(text="",cls=""){
  const out=$("consoleOut");if(!out)return;
  const d=document.createElement("div");
  d.className="co-line "+cls;
  d.textContent=text;
  out.appendChild(d);
  while(out.children.length>900)out.firstChild.remove();
  out.scrollTop=out.scrollHeight;
}
function coAppendLog(e){
  const out=$("consoleOut");if(!out)return;
  const d=document.createElement("div");
  d.className="co-line co-log l-"+e.level;
  d.textContent=new Date(e.t).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})+"  "+e.text;
  out.appendChild(d);
  while(out.children.length>900)out.firstChild.remove();
  out.scrollTop=out.scrollHeight;
}
function renderLogs(){
  $("consoleOut").innerHTML="";
  if(!LOGBUF.length){coPrint("(no logs yet — app activity will appear here)","co-dim");return}
  for(const e of LOGBUF)coAppendLog(e);
  const out=$("consoleOut");out.scrollTop=out.scrollHeight;
}
/* Virtual shell state: cwd as path segments, listing cached until a write. */
const SHELL={cwd:[],listing:null};
function shellPrompt(){return "nc:/"+SHELL.cwd.join("/")+(SHELL.cwd.length?"/":"")+"$"}
function tokenize(line){
  const out=[];const re=/"([^"]*)"|'([^']*)'|(\S+)/g;let m;
  while((m=re.exec(line)))out.push(m[1]!=null?m[1]:(m[2]!=null?m[2]:m[3]));
  return out;
}
async function shellList(){
  if(SHELL.listing)return SHELL.listing;
  const r=await fsCall("fsList","");
  if(r.error){
    if(r.result==="NO_PROJECT")throw Error("no folder connected — tap + → Project folder");
    if(r.result==="NO_BRIDGE")throw Error("filesystem bridge unavailable (browser preview)");
    throw Error(r.result);
  }
  SHELL.listing=(r.result==="EMPTY_PROJECT")?[]:r.result.split("\n").filter(Boolean);
  return SHELL.listing;
}
function resolveSegs(arg){
  const parts=(arg.startsWith("/")?[]:[...SHELL.cwd]).concat(arg.split("/"));
  const out=[];
  for(const p of parts){
    if(!p||p===".")continue;
    if(p==="..")out.pop();
    else out.push(p);
  }
  return out;
}
function underDir(listing,dir){
  const pre=dir.join("/");const out=[];
  for(let e of listing){
    const isDir=e.endsWith("/");const p=isDir?e.slice(0,-1):e;
    let rest;
    if(pre){if(!p.startsWith(pre+"/"))continue;rest=p.slice(pre.length+1)}
    else{if(p.includes("/"))continue;rest=p}
    if(!rest||rest.includes("/"))continue;
    out.push({name:rest,dir:isDir});
  }
  return out.sort((a,b)=>(a.dir===b.dir?0:(a.dir?-1:1))||a.name.localeCompare(b.name));
}
async function headTail(a,first){
  let n=10;const args=[...a];
  if(args[0]==="-n"&&args[1]){n=parseInt(args[1],10)||10;args.splice(0,2)}
  const file=args[0];
  if(!file)throw Error("file required (head/tail -n N file)");
  const r=await fsCall("fsRead",resolveSegs(file).join("/"));
  if(r.error)throw Error(r.result==="FILE_NOT_FOUND"?"no such file: "+file:r.result);
  const lines=r.result.split("\n");
  coPrint((first?lines.slice(0,n):lines.slice(-n)).join("\n")||"(empty file)");
  if(lines.length>n)coPrint("… "+lines.length+" lines total","co-dim");
}
const SHELL_CMDS={
  help:{d:"show commands",async run(){
    coPrint("NightCode shell — operates on the connected folder (SAF bridge)","co-dim");
    for(const n of Object.keys(SHELL_CMDS).sort())coPrint("  "+n.padEnd(9)+SHELL_CMDS[n].d);
    coPrint("Relative paths, cd/.. work. `js <expr>` evaluates JS in the app.","co-dim");
  }},
  pwd:{d:"print working dir",async run(){coPrint("/"+SHELL.cwd.join("/"))}},
  ls:{d:"list directory",async run(a){
    const dir=resolveSegs(a[0]||".");
    const listing=await shellList();
    if(dir.length){
      const full=dir.join("/")+"/";
      if(!listing.some(e=>e===full||e.startsWith(full)))throw Error("ls: no such directory: "+a[0]);
    }
    const es=underDir(listing,dir);
    if(!es.length){coPrint("(empty)","co-dim");return}
    for(const e of es)coPrint(e.name+(e.dir?"/":""),e.dir?"co-dir":"");
  }},
  cd:{d:"change directory",async run(a){
    if(!a[0]||a[0]==="/"){SHELL.cwd=[];return}
    const dir=resolveSegs(a[0]);
    if(!dir.length){SHELL.cwd=[];return}
    const listing=await shellList();
    const full=dir.join("/")+"/";
    if(!listing.some(e=>e===full||e.startsWith(full)))throw Error("cd: no such directory: "+a[0]);
    SHELL.cwd=dir;
  }},
  cat:{d:"print file",async run(a){
    if(!a[0])throw Error("cat: file required");
    const r=await fsCall("fsRead",resolveSegs(a[0]).join("/"));
    if(r.error)throw Error("cat: "+(r.result==="FILE_NOT_FOUND"?"no such file: "+a[0]:r.result));
    coPrint(r.result||"(empty file)");
  }},
  head:{d:"first N lines",async run(a){await headTail(a,true)}},
  tail:{d:"last N lines",async run(a){await headTail(a,false)}},
  grep:{d:"grep pattern [file]",async run(a){
    let ci=false;const args=[...a];
    if(args[0]==="-i"){ci=true;args.shift()}
    const pat=args[0];
    if(!pat)throw Error("grep: pattern required");
    if(args[1]){
      const r=await fsCall("fsRead",resolveSegs(args[1]).join("/"));
      if(r.error)throw Error("grep: "+r.result);
      const re=new RegExp(pat,ci?"i":"");
      const hits=r.result.split("\n").map((l,i)=>[i+1,l]).filter(([,l])=>re.test(l));
      if(!hits.length){coPrint("(no matches)","co-dim");return}
      for(const [n,l] of hits.slice(0,200))coPrint(n+": "+l.trim().slice(0,300));
    }else{
      const r=await fsCall("fsSearch",pat);
      if(r.error)throw Error("grep: "+r.result);
      const res=r.result==="NO_MATCHES"?[]:r.result.split("\n").filter(Boolean);
      if(!res.length){coPrint("(no matches)","co-dim");return}
      for(const f of res)coPrint(f,"co-dir");
    }
  }},
  find:{d:"find by name",async run(a){
    if(!a[0])throw Error("find: name required");
    const listing=await shellList();
    const hits=listing.filter(e=>e.toLowerCase().includes(a[0].toLowerCase()));
    if(!hits.length){coPrint("(nothing found)","co-dim");return}
    for(const h of hits)coPrint(h,"co-dir");
  }},
  tree:{d:"folder tree (2 levels)",async run(){
    const listing=await shellList();
    const pre=SHELL.cwd.join("/");
    const set=new Set();
    for(let e of listing){
      const isDir=e.endsWith("/");const p=isDir?e.slice(0,-1):e;
      if(pre&&!p.startsWith(pre+"/"))continue;
      const rest=pre?p.slice(pre.length+1):p;
      if(!rest)continue;
      const segs=rest.split("/");
      set.add(segs.slice(0,2).join("/")+(isDir&&segs.length<=2?"/":""));
    }
    const rows=[...set].sort();
    if(!rows.length){coPrint("(empty)","co-dim");return}
    rows.forEach((r,i)=>coPrint((i===rows.length-1?"└─ ":"├─ ")+r,r.endsWith("/")?"co-dir":""));
    if(rows.length>=40)coPrint("… "+rows.length+" shown, deeper entries hidden — use ls/cd","co-dim");
  }},
  mkdir:{d:"create directory",async run(a){
    if(!a[0])throw Error("mkdir: name required");
    const r=await fsCall("fsMkdir",resolveSegs(a[0]).join("/"));
    if(r.error)throw Error("mkdir: "+r.result);
    SHELL.listing=null;
    coPrint("created "+a[0],"co-ok");
  }},
  rm:{d:"delete file",async run(a){
    if(!a[0])throw Error("rm: file required");
    const r=await fsCall("fsDelete",resolveSegs(a[0]).join("/"));
    if(r.error)throw Error("rm: "+(r.result==="FILE_NOT_FOUND"?"no such file: "+a[0]:r.result));
    SHELL.listing=null;
    coPrint("deleted "+a[0],"co-ok");
  }},
  mv:{d:"move/rename from to",async run(a){
    if(a.length<2)throw Error("mv: from and to required");
    const from=resolveSegs(a[0]).join("/");
    const to=resolveSegs(a[1]).join("/");
    const r=await fsCall("fsRename",from,to);
    if(r.error)throw Error("mv: "+r.result);
    SHELL.listing=null;
    coPrint(from+" → "+to,"co-ok");
  }},
  cp:{d:"copy from to",async run(a){
    if(a.length<2)throw Error("cp: from and to required");
    const from=resolveSegs(a[0]).join("/");
    const to=resolveSegs(a[1]).join("/");
    const rd=await fsCall("fsRead",from);
    if(rd.error)throw Error("cp: "+rd.result);
    const wr=await fsCall("fsWrite",to,btoa(unescape(encodeURIComponent(rd.result))));
    if(wr.error)throw Error("cp: "+wr.result);
    SHELL.listing=null;
    coPrint(from+" → "+to,"co-ok");
  }},
  touch:{d:"create empty file",async run(a){
    if(!a[0])throw Error("touch: file required");
    const p=resolveSegs(a[0]).join("/");
    const ex=await fsCall("fsRead",p);
    if(!ex.error){coPrint(p+" already exists");return}
    const w=await fsCall("fsWrite",p,btoa(""));
    if(w.error)throw Error("touch: "+w.result);
    SHELL.listing=null;
    coPrint("created "+p,"co-ok");
  }},
  echo:{d:"print / write > file",async run(a,raw){
    let text=raw.replace(/^\s*echo\s?/,"");
    const m=text.match(/^(.*?)\s*(>>?)\s*(\S+)\s*$/);
    if(!m){coPrint(text);return}
    let content=m[1];
    if((content.startsWith('"')&&content.endsWith('"'))||(content.startsWith("'")&&content.endsWith("'")))content=content.slice(1,-1);
    const target=resolveSegs(m[3]).join("/");
    if(m[2]===">>"){
      const old=await fsCall("fsRead",target);
      if(!old.error)content=(old.result?old.result+"\n":"")+content;
    }
    const w=await fsCall("fsWrite",target,btoa(unescape(encodeURIComponent(content))));
    if(w.error)throw Error("echo: "+w.result);
    SHELL.listing=null;
    coPrint("wrote "+target,"co-ok");
  }},
  js:{d:"evaluate JS",async run(a,raw){
    const code=raw.replace(/^\s*js\s?/,"");
    if(!code.trim())throw Error("js: expression required");
    const r=await replEval(code);
    coPrint(r.text,r.ok?"co-ok":"co-err");
  }},
  open:{d:"open URL in browser",async run(a){
    if(!a[0])throw Error("open: url required");
    if(window.Android&&Android.openUrl)Android.openUrl(/^https?:\/\//.test(a[0])?a[0]:"https://"+a[0]);
    else throw Error("open: available in the Android app");
  }},
  send:{d:"ask the agent",async run(a,raw){
    const p=raw.replace(/^\s*send\s?/,"").trim();
    if(!p)throw Error("send: prompt required");
    closeSheets();
    await send(p);
  }},
  history:{d:"command history",async run(){
    if(!CON.hist.shell.length){coPrint("(empty)","co-dim");return}
    for(const h of CON.hist.shell)coPrint(h,"co-dim");
  }},
  clear:{d:"clear output",async run(){$("consoleOut").innerHTML=""}}
};
async function runShellLine(raw){
  coPrint(shellPrompt()+" "+raw,"co-cmd");
  pushHist("shell",raw.trim());
  const line=raw.trim();
  if(!line)return;
  const parts=tokenize(line);
  const c=SHELL_CMDS[parts[0]];
  if(!c){coPrint(parts[0]+": command not found — try `help`","co-err");return}
  try{await c.run(parts.slice(1),line)}
  catch(e){coPrint(String(e&&e.message||e),"co-err")}
}
async function replEval(code){
  const fmtVal=v=>{
    if(v===undefined)return "undefined";
    if(typeof v==="function")return "ƒ "+(v.name||"anonymous");
    try{const s=JSON.stringify(v,null,1);return s===undefined?String(v):s}
    catch(e){return String(v)}
  };
  try{
    let v;
    if(/\bawait\b/.test(code)){
      try{v=await (0,eval)("(async()=>("+code+"))()")}
      catch(e){if(!(e instanceof SyntaxError))throw e}
      v=await (0,eval)("(async()=>{"+code+"})()");
    }else{
      try{v=(0,eval)("("+code+")")}
      catch(e){if(!(e instanceof SyntaxError))throw e}
      v=(0,eval)(code);
    }
    return {ok:true,text:fmtVal(v)};
  }catch(e){return {ok:false,text:String(e&&e.message||e)}}
}
async function runJsLine(raw){
  coPrint("js> "+raw,"co-cmd");
  pushHist("js",raw.trim());
  if(!raw.trim())return;
  const r=await replEval(raw);
  coPrint(r.text,r.ok?"co-ok":"co-err");
}
/* ── SSH tab: remote shell over the persistent session ── */
let sshConsoleBusy=false;
async function runSshLine(raw){
  const line=raw.trim();
  coPrint("ssh$ "+line,"co-cmd");
  if(!line)return;
  pushHist("ssh",line);
  if(line==="help"){
    coPrint("SSH console — commands run on the remote server.");
    coPrint("  connect host[:port] user [password]   connect (or use Settings → SSH)","co-dim");
    coPrint("  status | disconnect                    connection control","co-dim");
    coPrint("  anything else runs remotely via bash","co-dim");
    return;
  }
  if(line==="status"){
    coPrint((window.Android&&Android.sshIsConnected&&Android.sshIsConnected())?"connected":(sshToolsAvailable()?"saved config, not connected — run a command to auto-connect":"no SSH config — Settings → SSH"),"co-dim");
    return;
  }
  if(line==="disconnect"){
    const r=await sshCall("disconnect");
    coPrint(r.msg||"disconnected",r.error?"co-err":"co-ok");
    updateConsoleInfo();
    return;
  }
  if(sshConsoleBusy){coPrint("(another command is running — wait)","co-dim");return}
  sshConsoleBusy=true;
  try{
    const ensure=await sshEnsureConnected();
    if(!ensure.ok){coPrint("SSH not connected: "+(ensure.msg||"")+" — Settings → SSH","co-err");return}
    updateConsoleInfo();
    const r=await new Promise(resolve=>{
      const cbId="ssh"+(++sshCbId);
      sshCbs[cbId]={onLine:l=>coPrint(String(l)),onDone:resolve};
      try{Android.sshExec(line,180,cbId)}catch(e){delete sshCbs[cbId];resolve({code:-1,msg:String(e&&e.message||e),error:true})}
    });
    if(r.error)coPrint("⚠ "+(r.msg||"error"),"co-err");
    else if(r.code!==0)coPrint("(exit "+r.code+")","co-dim");
  }finally{sshConsoleBusy=false;updateConsoleInfo()}
}
function pushHist(tab,line){
  if(!line)return;
  const h=CON.hist[tab];
  if(!h)return;
  if(h[h.length-1]!==line)h.push(line);
  while(h.length>50)h.shift();
  localStorage.setItem(tab==="shell"?"ncHistShell":(tab==="ssh"?"ncHistSsh":"ncHistJs"),JSON.stringify(h));
  CON.hi[tab]=-1;
}
function setConsoleTab(tab){
  CON.tab=tab;
  document.querySelectorAll(".ctab").forEach(b=>b.classList.toggle("active",b.dataset.ctab===tab));
  $("consoleRow").style.display=tab==="logs"?"none":"flex";
  $("consolePrompt").textContent=tab==="js"?"js>":(tab==="ssh"?"ssh$":shellPrompt());
  $("consoleInput").placeholder=tab==="js"?"expression (Enter to eval)":(tab==="ssh"?"command or connect": "help");
  if(tab==="logs")renderLogs();
  else if(!$("consoleOut").children.length)coEmptyState(tab);
}
function coEmptyState(tab){
  coPrint(tab==="js"?"JS REPL — evaluate expressions against the page context. Try `1+1`.":(tab==="ssh"?"SSH — remote shell on the connected server. Try `connect` first, then any command.":"Shell — runs on the connected folder. Try `help` or `ls`."),"co-dim");
}
function updateConsoleInfo(){
  const el=$("consoleInfo");
  if(!el)return;
  if(CON.tab==="ssh"){
    el.textContent=(window.Android&&Android.sshIsConnected&&Android.sshIsConnected())?"🌐 connected":(sshToolsAvailable()?"SSH saved, not connected":"no SSH");
    return;
  }
  el.textContent=state.projectName?("📁 "+state.projectName):"no folder";
}
function openConsole(){
  openSheet("consoleSheet");
  updateConsoleInfo();
  setConsoleTab(CON.tab);
  setTimeout(()=>{try{$("consoleInput").focus()}catch(e){}},250);
}

/* ── Extensions: user JS that adds agent tools, slash commands and hooks ── */
const EXT={tools:new Map(),commands:new Map(),events:{message:[],tool:[]},exts:[]};
function extEnabled(name){return state.extEnabled[name]!==false}
function fireExt(ev,payload){
  for(const h of (EXT.events[ev]||[])){
    try{h(payload)}
    catch(e){console.log("[NightCode] ext "+ev+" handler error "+String(e&&e.message||e))}
  }
}
function extToolDefs(){
  const out=[];
  for(const t of EXT.tools.values())
    if(extEnabled(t.ext))out.push({name:t.name,description:t.description||t.name,input_schema:t.schema||{type:"object",properties:{}}});
  return out;
}
function makeNcApi(meta,allowRegister){
  const api={
    on(ev,fn){if(EXT.events[ev]&&typeof fn==="function")EXT.events[ev].push(fn)},
    http:(m,u,h,b)=>httpFetch(m,u,h,b),
    fs:{
      read:async p=>{const r=await fsCall("fsRead",p);if(r.error)throw Error(r.result);return r.result},
      write:async(p,c)=>{const r=await fsCall("fsWrite",p,btoa(unescape(encodeURIComponent(String(c||"")))));if(r.error)throw Error(r.result);return r.result},
      list:async p=>{const r=await fsCall("fsList",p||"");if(r.error)throw Error(r.result);return r.result==="EMPTY_PROJECT"?[]:r.result.split("\n").filter(Boolean)}
    },
    banner:showBanner,
    chat:t=>addMessage("assistant",String(t)),
    send:t=>send(String(t)),
    get state(){return {model:state.selected,project:state.projectName,hasProject:hasProject(),messages:state.messages.length}}
  };
  if(!allowRegister)return api;
  api.register=def=>{
    def=def||{};
    const name=def.name||meta.name;
    const rec={name,version:def.version||"",file:meta.file,tools:[],commands:[],error:""};
    if(def.tools)for(const t of def.tools){
      if(!t||!t.name||typeof t.run!=="function"){rec.error="tool missing name/run";continue}
      if(EXT.tools.has(t.name)&&EXT.tools.get(t.name).ext!==name){rec.error="duplicate tool "+t.name;continue}
      EXT.tools.set(t.name,{...t,ext:name});
      rec.tools.push(t.name);
    }
    if(def.commands)for(const [cname,fn] of Object.entries(def.commands)){
      const key=cname.replace(/^\//,"");
      if(typeof fn!=="function")continue;
      EXT.commands.set(key,{fn,ext:name,desc:(def.commandHelp&&def.commandHelp[key])||""});
      rec.commands.push(key);
    }
    EXT.exts.push(rec);
  };
  return api;
}
async function loadExtensions(){
  EXT.tools.clear();EXT.commands.clear();
  EXT.events={message:[],tool:[]};EXT.exts.length=0;
  const sources=[];
  // 1) workspace/extensions/*.js — persistent across projects
  if(window.Android&&Android.hasWorkspace&&Android.hasWorkspace()){
    const r=await fsCall("fsList","workspace:extensions");
    if(!r.error&&r.result&&r.result!=="EMPTY_PROJECT")
      for(const l of r.result.split("\n"))if(l.endsWith(".js"))sources.push({name:l.replace(/\.js$/,""),file:"workspace:extensions/"+l,src:null});
  }
  // 2) project .nightcode/extensions/*.js — tools shipped with the repo
  if(hasProject()){
    const r=await fsCall("fsList","");
    if(!r.error&&r.result&&r.result!=="EMPTY_PROJECT")
      for(const l of r.result.split("\n"))if(/^\.nightcode\/extensions\/[^/]+\.js$/.test(l))sources.push({name:l.split("/").pop().replace(/\.js$/,""),file:l,src:null});
  }
  // 3) inline snippets saved in the manager
  state.extInline.forEach((src,i)=>sources.push({name:"inline"+(i+1),file:"inline#"+i,src}));
  for(const s of sources){
    let src=s.src;
    if(src==null){
      const r=await fsCall("fsRead",s.file);
      if(r.error){EXT.exts.push({name:s.name,file:s.file,tools:[],commands:[],error:"read failed: "+r.result});continue}
      src=r.result;
    }
    try{(new Function("nc",'"use strict";\n'+src))(makeNcApi({name:s.name,file:s.file},true))}
    catch(e){EXT.exts.push({name:s.name,file:s.file,tools:[],commands:[],error:String(e&&e.message||e)})}
  }
  console.log("[NightCode] extensions loaded "+JSON.stringify({sources:sources.length,tools:EXT.tools.size,commands:EXT.commands.size}));
  renderExtList();
}
function renderExtList(){
  const box=$("extList");if(!box)return;
  if(!EXT.exts.length){
    box.innerHTML='<div class="ext-empty">No extensions loaded.<br>Drop .js files into <b>workspace/extensions/</b><br>or <b>.nightcode/extensions/</b> in the project.</div>';
    return;
  }
  box.innerHTML=EXT.exts.map(e=>{
    const on=extEnabled(e.name);
    const del=e.file.match(/^inline#(\d+)$/);
    return `<div class="ext-row ${e.error?"err":""}">
      <div class="ext-main">
        <div class="ext-name">${esc(e.name)}${e.version?' <small>v'+esc(e.version)+"</small>":""}</div>
        <div class="ext-meta">${e.error?("⚠ "+esc(e.error)):(e.tools.length+" tools · "+e.commands.length+" cmds · "+esc(e.file))}</div>
      </div>
      ${del?`<button class="ext-del" onclick="delInlineExt(${del[1]})">remove</button>`:""}
      <label class="ext-toggle"><input type="checkbox" ${on?"checked":""} onchange="toggleExt(decodeURIComponent('${encodeURIComponent(e.name)}'),this.checked)"></label>
    </div>`;
  }).join("");
}
function toggleExt(name,on){state.extEnabled[name]=on;save()}
function delInlineExt(i){state.extInline.splice(Number(i)||0,1);save();loadExtensions()}

/* ── Slash commands (built-in + extension) with autocomplete ── */
const SLASH_BUILTIN={
  help:{desc:"list commands",fn(){
    const rows=Object.entries(SLASH_BUILTIN).map(([n,d])=>"/"+n+" — "+d.desc);
    for(const [n,c] of EXT.commands)if(extEnabled(c.ext))rows.push("/"+n+(c.desc?" — "+c.desc:""));
    addMessage("assistant","Commands:\n"+rows.sort().join("\n"));
  }},
  new:{desc:"start a new chat",fn(){newChat()}},
  compact:{desc:"compact context now",fn(){compactNow(false);showBanner("Context compacted")}},
  tools:{desc:"list agent tools",fn(){
    const base=(hasProject()?FILE_TOOLS.map(t=>t.name):[]).concat(["web_search","web_fetch"]);
    if(sshToolsAvailable())base.push(...SSH_TOOLS.map(t=>t.name));
    if(ghToolsAvailable())base.push("github_api");
    const ext=[...EXT.tools.values()].filter(t=>extEnabled(t.ext)).map(t=>t.name);
    addMessage("assistant","Agent tools:\n"+base.concat(ext).join("\n"));
  }},
  ext:{desc:"list extensions",fn(){openSheet("extSheet");renderExtList()}},
  console:{desc:"open console",fn(){openConsole()}},
  ssh:{desc:"open SSH console",fn(){openConsole();setConsoleTab("ssh")}},
  model:{desc:"choose model",fn(){$("modelBtn").click()}}
};
async function handleSlash(prompt){
  const sp=prompt.indexOf(" ");
  const name=(sp<0?prompt:prompt.slice(0,sp)).replace(/^\//,"");
  const argsStr=sp<0?"":prompt.slice(sp+1).trim();
  const b=SLASH_BUILTIN[name];
  if(b){try{b.fn(argsStr)}catch(e){showBanner("Command failed: "+(e&&e.message||e))}return}
  const c=EXT.commands.get(name);
  if(c){
    if(!extEnabled(c.ext)){showBanner("Extension '"+c.ext+"' is disabled");return}
    try{await c.fn(argsStr,makeNcApi({name:c.ext,file:"command"},false))}
    catch(e){addMessage("assistant","⚠️ Command /"+name+" failed: "+(e&&e.message||e))}
    return;
  }
  showBanner("Unknown command /"+name+" — /help lists commands");
}
function slashCommands(){
  const out=[];
  for(const [n,d] of Object.entries(SLASH_BUILTIN))out.push({name:n,desc:d.desc});
  for(const [n,c] of EXT.commands)if(extEnabled(c.ext))out.push({name:n,desc:c.desc||(c.ext+" extension")});
  return out;
}
function updateSlashMenu(){
  const menu=$("slashMenu");if(!menu)return;
  const v=$("input").value;
  if(!v.startsWith("/")||v.includes(" ")||v.includes("\n")){menu.classList.remove("show");return}
  const hits=slashCommands().filter(c=>c.name.startsWith(v.slice(1).toLowerCase()));
  if(!hits.length){menu.classList.remove("show");return}
  menu.innerHTML=hits.map(c=>`<button class="slash-item" data-cmd="${esc(c.name)}"><b>/${esc(c.name)}</b><small>${esc(c.desc)}</small></button>`).join("");
  menu.classList.add("show");
  menu.querySelectorAll(".slash-item").forEach(b=>b.onclick=()=>{
    $("input").value="/"+b.dataset.cmd+" ";
    menu.classList.remove("show");
    $("input").focus();
  });
}

/* ── Chat sessions & projects (grouping) ── */
function currentSessionId(){
  // Simple stable id: bump when a chat is cleared, reuse otherwise.
  let id=localStorage.getItem("currentSession");
  if(!id){id="s"+Date.now();localStorage.setItem("currentSession",id)}
  return id;
}
function newChat(){
  const wasAlreadyEmpty=!state.messages.length;
  saveCurrentChat();
  state.messages=[];state.tree={rootId:null,nodes:{}};state.summary="";state.attachments=[];state.lastUsage=null;save();render();renderAttachments();renderRecent();renderCtxRing();
  localStorage.removeItem("currentSession");
  currentSessionId();
  $("input").focus();
  // Starting a new chat from an already-empty chat changes nothing on screen —
  // show a banner so the tap has visible feedback instead of feeling ignored.
  if(wasAlreadyEmpty){
    const w=$("welcome");
    if(w)w.insertAdjacentHTML("beforeend",'<div class="sys-banner" id="sysBanner"><svg><use href="#i-check"/></svg><span>New chat started</span></div>');
    setTimeout(()=>{const b=$("sysBanner");if(b)b.remove()},1800);
  }
}
function addToProject(){
  if(!state.projects.length){
    const name=prompt("Project name:");
    if(!name)return;
    state.projects.push({id:"p"+Date.now(),name,sessionIds:[]});
  }
  const p=state.projects[0];
  const sid=currentSessionId();
  if(!p.sessionIds.includes(sid))p.sessionIds.push(sid);
  save();
  showBanner("Chat added to project: "+p.name);
}

function resizeInput(){$("input").style.height="auto";$("input").style.height=Math.min($("input").scrollHeight,150)+"px"}

/* ── Tool activity cards ────────────── */
function toolIcon(name){
  const paths={
    list_files:'<path d="M4 6h16v13H4z"/><path d="M7 10h10M7 14h7"/>',
    read_file:'<path d="M6 3h9l3 3v15H6z"/><path d="M9 12h6M9 16h5"/>',
    search_files:'<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>',
    get_file_info:'<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    write_file:'<path d="M5 4h14v16H5z"/><path d="m8 16 8-8M13 7l4 4"/>',
    create_directory:'<path d="M3 6h7l2 2h9v11H3z"/><path d="M12 11v5M9.5 13.5h5"/>',
    rename_file:'<path d="M5 5h14v14H5z"/><path d="m8 15 7-7M13 8h2v2"/>',
    delete_file:'<path d="M5 7h14M9 7V4h6v3M8 10v7M12 10v7M16 10v7M6 7l1 13h10l1-13"/>',
    web_search:'<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.3 3.9 5.2 3.9 8.5S14.6 18.2 12 20.5c-2.6-2.3-3.9-5.2-3.9-8.5S9.4 5.8 12 3.5z"/>',
    web_fetch:'<path d="M12 3a9 9 0 1 0 9 9"/><path d="M21 3v6h-6"/>',
    ssh_exec:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    ssh_upload:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 15V8M9 11l3-3 3 3"/>',
    ssh_download:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 8v7M9 12l3 3 3-3"/>',
    github_api:'<path d="M10.2 17.3c-2.97-.36-5.06-2.49-5.06-5.26 0-1.12.4-2.34 1.08-3.14-.3-.74-.25-2.31.09-2.97.9-.11 2.11.36 2.83 1.01.85-.27 1.75-.4 2.85-.4s2 .14 2.81.38c.7-.63 1.93-1.1 2.83-.99.32.61.36 2.18.07 2.94.72.85 1.1 2 1.1 3.17 0 2.76-2.09 4.85-5.1 5.23.76.5 1.28 1.57 1.28 2.8v2.34c0 .67.56 1.06 1.24.79C20.07 18.45 23.5 14.38 23.5 9.55 23.5 4.19 18.33 0 12 0S.5 4.19.5 9.55c0 4.99 3.17 9.12 7.43 10.67.61.22 1.19-.18 1.19-.79v-2.36a2.9 2.9 0 0 1-1.08.22c-1.48 0-2.36-.81-2.99-2.31-.25-.61-.52-.97-1.03-1.03-.27-.03-.36-.14-.36-.27 0-.27.45-.47.9-.47.65 0 1.21.4 1.8 1.24.45.65.92.94 1.48.94.56 0 .92-.2 1.44-.72.38-.38.67-.72.94-.94z"/>',
    __ext:'<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13.5v6M13.5 16.5h6"/>'
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+(paths[name]||paths.__ext)+'</svg>';
}
function toolLabel(name){return ({list_files:'Inspecting project files',read_file:'Reading file',search_files:'Searching project',get_file_info:'Inspecting file',write_file:'Writing file',create_directory:'Creating folder',rename_file:'Renaming file',delete_file:'Deleting file',web_search:'Searching the web',web_fetch:'Reading web page',ssh_exec:'Running remote command',ssh_upload:'Uploading to server',ssh_download:'Downloading from server',github_api:'Calling GitHub API'}[name]||String(name||'').replace(/_/g,' '))}
/* Claude-style one-line labels: past tense + target, e.g. Searched "query" */
function toolCompactLabel(t){
  const target=toolTarget(t.input)||"";
  const short=target.length>40?target.slice(0,37)+"…":target;
  const map={
    web_search:'Searched "'+short+'"',
    web_fetch:'Read '+short,
    read_file:'Read '+short,
    write_file:'Edited '+short,
    list_files:'Listed project files',
    search_files:'Searched project for "'+short+'"',
    create_directory:'Created '+short,
    rename_file:'Renamed to '+short,
    delete_file:'Deleted '+short,
    get_file_info:'Inspected '+short,
    ssh_exec:'Ran `'+short+'` on server',
    ssh_upload:'Uploaded '+short,
    ssh_download:'Downloaded '+short,
    github_api:'GitHub: '+short
  };
  let label=map[t.name]||toolLabel(t.name);
  if(t.error)label+=" — failed";
  return label;
}
function toolTarget(input){return input?.path||input?.to||input?.query||input?.url||input?.command||input?.remotePath||''}
function makeTree(text){
  // Root-level view only: directories first, then files. No recursive branches.
  const lines=String(text||"").split("\n").filter(Boolean);
  const dirs=[];const files=[];
  for(const line of lines){
    const isDir=line.endsWith("/");
    const clean=isDir?line.slice(0,-1):line;
    if(clean.includes("/"))continue;  // nested — model still sees it, UI doesn't
    (isDir?dirs:files).push(clean);
  }
  const out=[];
  for(const d of dirs.slice(0,30))out.push("📁 "+d+"/");
  for(const f of files.slice(0,30))out.push("📄 "+f);
  if(!out.length)return "Empty folder";
  if(dirs.length+files.length>out.length)out.push("… +"+(dirs.length+files.length-out.length)+" more");
  return out.join("\n");
}
function toolPreview(name,input,result){
  const out=String(result||"");
  if(name==="list_files")return '<div class="tree-title">PROJECT ROOT</div><div class="tree">'+esc(makeTree(out))+'</div>';
  if(name==="search_files")return '<div class="tree-title">MATCHES</div><div class="tree">'+esc(out.split("\n").slice(0,20).join("\n")||"No matches")+'</div>';
  if(name==="web_search")return '<div class="tree-title">RESULTS</div><div class="tree">'+esc(out.split("\n\n").slice(0,8).join("\n\n")||"No results")+'</div>';
  // The file path is already in the card subtitle (.tool-activity-sub) — no badge.
  return '<pre>'+esc(out.slice(0,5000))+"</pre>";
}
function showToolActivity(name,input){
  const chat=$("chat");
  removeTyping();
  const wrap=document.createElement("div");wrap.className="message assistant";
  const card=document.createElement("div");card.className="tool-activity compact";
  card.innerHTML='<div class="tool-activity-head"><div class="tool-activity-icon sm">'+toolIcon(name)+'</div><div class="tool-activity-text"><div class="tool-activity-title">'+esc(toolCompactLabel({name,input}))+'</div></div><div class="tool-activity-status"><span class="tool-spinner"></span></div></div><div class="tool-preview" style="display:none"></div>';
  wrap.appendChild(card);chat.appendChild(wrap);autoScroll();
  return {update(result,error=false){
    card.querySelector(".tool-preview").innerHTML=toolPreview(name,input,result);
    card.querySelector(".tool-preview").style.display="";
    card.classList.add("done");
    const st=card.querySelector(".tool-activity-status");
    st.innerHTML=error?'<span style="color:#ff7279">✕</span>':'<svg style="width:14px;height:14px;color:#7fd6a2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>';
    if(error)card.querySelector(".tool-activity-icon").style.color="#ff7279";
    autoScroll();
  }};
}

$("menuBtn").onclick=()=>{renderRecent();$("drawer").classList.add("open");$("scrim").classList.add("open")}
$("closeDrawer").onclick=()=>{$("drawer").classList.remove("open");$("scrim").classList.remove("open")}
$("scrim").onclick=()=>{$("drawer").classList.remove("open");$("scrim").classList.remove("open")}
$("drawerNew").onclick=()=>{newChat();$("closeDrawer").click()}
$("drawerConsole").onclick=()=>{$("closeDrawer").click();openConsole()}
$("addBtn").onclick=()=>openSheet("addSheet")
$("rowProjectFolder").onclick=()=>{closeSheets();openProjectsSheet()}
$("rowWebSearch").onclick=()=>{closeSheets();$("input").focus()}
$("rowAddToProject").onclick=()=>{closeSheets();addToProject()}
$("rowToolAccess").onclick=()=>{closeSheets();openSheet("contextSheet")}
async function openProjectsSheet(){
  openSheet("projectsSheet");
  const hasWs=!!(window.Android&&Android.hasWorkspace&&Android.hasWorkspace());
  $("projectsWsSetup").style.display=hasWs?"none":"";
  $("projectsWsBody").style.display=hasWs?"":"none";
  if(!hasWs)return;
  const list=$("projectsList");
  list.innerHTML='<div class="ext-empty">Loading…</div>';
  const names=await listWorkspaceProjects();
  if(!names.length){list.innerHTML='<div class="ext-empty">No projects yet — create one above.</div>';return}
  list.innerHTML=names.map(n=>`<button class="recent-chat project-row ${n===state.projectName?"active":""}" data-project="${esc(n)}">
    <span class="chat-dot"></span>
    <span class="recent-chat-main"><span class="recent-chat-title">${esc(n)}</span></span>
    ${n===state.projectName?'<span class="row-arrow"><svg><use href="#i-check"/></svg></span>':""}
  </button>`).join("");
}
document.addEventListener("click",e=>{const card=e.target.closest("#openProjectCard");if(card)openProjectsSheet()});
document.addEventListener("click",e=>{
  const row=e.target.closest(".project-row");
  if(row){switchWorkspaceProject(row.dataset.project).then(()=>closeSheets());return}
});
$("projectsPickWs").onclick=()=>{if(window.Android&&Android.openWorkspacePicker)Android.openWorkspacePicker();else alert("Available in the Android app.")}
$("projectsOtherFolder").onclick=()=>{closeSheets();openProject()}
async function createProjectFromInput(){
  const input=$("newProjectName");
  const name=input.value.trim();
  if(!name)return;
  if(!/^[\w.-]+$/.test(name)){alert("Use letters, numbers, - or _ only.");return}
  const btn=$("newProjectBtn");btn.disabled=true;
  const r=await createWorkspaceProject(name);
  btn.disabled=false;
  if(!r.ok){alert("Couldn't create project: "+r.error);return}
  input.value="";
  closeSheets();
}
$("newProjectBtn").onclick=createProjectFromInput;
$("newProjectName").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();createProjectFromInput()}});
$("modelBtn").onclick=()=>{openSheet("modelSheet");renderModels()}
function updateSshStatusUI(connected){
  const el=$("sshStatus");if(!el)return;
  el.className="key-status";
  if(connected){el.classList.add("ok");el.textContent="Connected";return}
  const saved=(window.Android&&Android.sshSavedHost)?Android.sshSavedHost():"";
  if(saved){
    try{const c=JSON.parse(saved);el.classList.add("checking");el.textContent="Saved: "+(c.user||"?")+(c.user?"@":"")+(c.host||"")+(c.port&&c.port!==22?":"+c.port:"")}
    catch(e){el.classList.add("checking");el.textContent="Saved connection"}
  }else{el.textContent="Not configured"}
}
/* ── GitHub auth UI ── */
function updateGhStatusUI(){
  const el=$("ghStatus");if(!el)return;
  el.className="key-status";
  if(state.ghToken){el.classList.add("ok");el.textContent="Signed in"+(state.ghUser?" as "+state.ghUser:"")}
  else el.textContent="Not connected";
}
let ghDeviceBusy=false;
async function ghDeviceFlow(){
  if(ghDeviceBusy)return;
  if(!state.ghClientId){$("ghClientIdInput").focus();$("ghStatus").className="key-status bad";$("ghStatus").textContent="Enter OAuth Client ID first";return}
  ghDeviceBusy=true;
  try{
  const st=$("ghStatus");st.className="key-status checking";st.textContent="Requesting device code…";
  const d=await ghDeviceStart();
  if(d.error){st.className="key-status bad";st.textContent=String(d.error).slice(0,160);return}
  const code=d.user_code||"";
  const uri=d.verification_uri||"https://github.com/login/device";
  if(window.Android&&Android.openUrl)Android.openUrl(uri);
  else window.open(uri,"_blank");
  st.className="key-status checking";
  st.innerHTML='Waiting for approval — enter this code in the browser:<br><b style="font-size:16px;letter-spacing:2px">'+esc(code)+"</b>";
  const res=await ghDevicePoll(d.device_code,d.interval);
  if(res.error){st.className="key-status bad";st.textContent=String(res.error).slice(0,160);return}
  const user=await ghSaveToken(res.token);
  if(!user){st.className="key-status bad";st.textContent="Token received but /user failed — check scopes";return}
  updateGhStatusUI();
  }finally{ghDeviceBusy=false}
}
$("ghDeviceBtn").onclick=ghDeviceFlow;
$("ghPatBtn").onclick=()=>{const r=$("ghPatRow");r.style.display=r.style.display==="none"?"block":"none"};
$("ghPatSave").onclick=async()=>{
  const t=$("ghTokenInput").value.trim();
  if(!t)return;
  const st=$("ghStatus");st.className="key-status checking";st.textContent="Checking token…";
  const user=await ghSaveToken(t);
  if(!user){state.ghToken="";save();st.className="key-status bad";st.textContent="Invalid token";return}
  $("ghTokenInput").value="";
  updateGhStatusUI();
};
$("ghPatCheck").onclick=async()=>{
  const st=$("ghStatus");
  if(!state.ghToken){st.className="key-status bad";st.textContent="No token saved";return}
  st.className="key-status checking";st.textContent="Checking…";
  state.ghUser=await ghFetchLogin()||"";save();
  if(state.ghUser)updateGhStatusUI();else{st.className="key-status bad";st.textContent="Token invalid or expired"}
};
$("ghDisconnectBtn").onclick=()=>{state.ghToken="";state.ghUser="";save();updateGhStatusUI()};
$("ghClientIdInput").addEventListener("change",e=>{state.ghClientId=e.target.value.trim();save()});
$("moreBtn").onclick=()=>{openSheet("settingsSheet");$("baseUrl").value=state.base;$("apiKey").value=state.key;updateSearchUI();updateWorkspaceUI();updateSshStatusUI(window.Android&&Android.sshIsConnected&&Android.sshIsConnected());$("ghClientIdInput").value=state.ghClientId;updateGhStatusUI()};
$("sshConnectBtn").onclick=async()=>{
  if(!window.Android||!Android.sshConnect){alert("SSH is available in the Android app.");return}
  const host=$("sshHost").value.trim();
  const user=$("sshUser").value.trim();
  if(!host||!user){$("sshStatus").textContent="Host and user required";$("sshStatus").className="key-status bad";return}
  const btn=$("sshConnectBtn");btn.disabled=true;
  const st=$("sshStatus");st.className="key-status checking";st.textContent="Connecting…";
  const key=$("sshKey").value.trim();
  const params={host,port:Number($("sshPort").value.trim())||22,user,password:$("sshPass").value,privateKey:key?btoa(unescape(encodeURIComponent(key))):"",passphrase:"",save:true};
  const r=await sshCall("connect",JSON.stringify(params));
  btn.disabled=false;
  if(r.error){st.className="key-status bad";st.textContent="Failed: "+String(r.msg||"").slice(0,140)}
  else{st.className="key-status ok";st.textContent="Connected to "+user+"@"+host;$("sshPass").value="";$("sshKey").value=""}
};
$("sshDisconnectBtn").onclick=async()=>{await sshCall("disconnect");updateSshStatusUI(false)};
$("sshForgetBtn").onclick=()=>{
  if(window.Android&&Android.sshForget)Android.sshForget();
  updateSshStatusUI(false);
};
/* Console & extensions wiring */
$("consoleClose").onclick=closeSheets;
$("consoleClear").onclick=()=>{
  if(CON.tab==="logs"){LOGBUF.length=0;renderLogs()}
  else{$("consoleOut").innerHTML="";coEmptyState(CON.tab);if(CON.tab==="ssh")updateConsoleInfo()}
};
document.querySelectorAll(".ctab").forEach(b=>b.onclick=()=>setConsoleTab(b.dataset.ctab));
$("consoleInput").addEventListener("keydown",e=>{
  const inp=e.target;
  const hist=CON.hist[CON.tab];
  if(e.key==="Enter"){
    const v=inp.value;inp.value="";
    if(CON.tab==="shell")runShellLine(v);
    else if(CON.tab==="ssh")runSshLine(v);
    else runJsLine(v);
  }else if(e.key==="ArrowUp"){
    if(!hist||!hist.length)return;
    e.preventDefault();
    if(CON.hi[CON.tab]<0)CON.hi[CON.tab]=hist.length;
    CON.hi[CON.tab]=Math.max(0,CON.hi[CON.tab]-1);
    inp.value=hist[CON.hi[CON.tab]]||"";
  }else if(e.key==="ArrowDown"){
    if(!hist||CON.hi[CON.tab]<0)return;
    e.preventDefault();
    CON.hi[CON.tab]=Math.min(hist.length,CON.hi[CON.tab]+1);
    inp.value=hist[CON.hi[CON.tab]]||"";
    if(CON.hi[CON.tab]>=hist.length)CON.hi[CON.tab]=-1;
  }
});
$("extBtn").onclick=()=>{openSheet("extSheet");renderExtList()};
$("extReload").onclick=async()=>{const b=$("extReload");b.disabled=true;await loadExtensions();b.disabled=false};
$("extAddInline").onclick=()=>{
  const ta=$("extInlineSrc");
  if(!ta.value.trim())return;
  state.extInline.push(ta.value);save();ta.value="";
  loadExtensions();
};
function updateSearchUI(){
  const sel=$("searchProviderSel");if(!sel)return;
  sel.value=state.searchProvider;
  const st=$("keyStatus");if(!st)return;
  st.className="key-status";
  const ollamaOn=state.searchProvider==="ollama"||(state.searchProvider==="auto"&&state.ollamaKey);
  if(state.searchProvider==="free")st.textContent="Free search (Bing / Google News)";
  else if(!state.ollamaKey)st.textContent="Enter your Ollama API key";
  else if(state._ollamaVerified){st.className="key-status ok";st.textContent="Ollama search ✓ active"}
  else st.textContent="Key saved — press Check key";
}
/* Quick key check: a 1-result search. Auto-runs on toggle/entry, manual button too. */
async function verifyOllamaKey(){
  const st=$("keyStatus");
  if(!st)return;
  if(!state.ollamaKey){st.className="key-status";st.textContent="Enter your Ollama API key";return}
  st.className="key-status checking";st.textContent="Checking key…";
  const btn=$("verifyOllamaBtn");if(btn)btn.disabled=true;
  const r=await ollamaApi("web_search",{query:"test",max_results:1});
  if(btn)btn.disabled=false;
  state._ollamaVerified=false;
  if(!r.error&&r.status>=200&&r.status<300){
    state._ollamaVerified=true;
    st.className="key-status ok";st.textContent="Ollama search ✓ active";
  }else if(r.status===401||r.status===403){
    st.className="key-status bad";st.textContent="Key invalid — get one at ollama.com/settings/keys";
  }else if(r.error){
    st.className="key-status bad";st.textContent="Network error: "+String(r.body||"").slice(0,80);
  }else{
    st.className="key-status bad";st.textContent="Key check failed (HTTP "+r.status+")";
  }
}
$("searchProviderSel").onchange=e=>{state.searchProvider=e.target.value;save();updateSearchUI()}
$("chatSearch").addEventListener("input",renderRecent)
$("chat").addEventListener("click",e=>{
  const copyBtn=e.target.closest(".code-copy-btn");
  if(copyBtn){
    const code=decodeURIComponent(copyBtn.dataset.code||"");
    copyToClipboard(code).then(ok=>{
      copyBtn.classList.toggle("copied",ok);
      setTimeout(()=>copyBtn.classList.remove("copied"),1400);
    });
    return;
  }
  const actBtn=e.target.closest(".msg-act-btn");
  if(actBtn){
    const msgEl=actBtn.closest(".message");
    const idx=Number(msgEl&&msgEl.dataset.idx);
    if(Number.isNaN(idx))return;
    const act=actBtn.dataset.act;
    if(act==="copy"){
      const m=state.messages[idx];
      copyToClipboard(m&&m.text||"").then(ok=>{
        actBtn.classList.toggle("copied",ok);
        setTimeout(()=>actBtn.classList.remove("copied"),1400);
      });
    }else if(act==="retry")retryMessage(idx);
    else if(act==="edit")editMessage(idx);
    else if(act==="prevVariant"||act==="nextVariant"){
      const switchEl=actBtn.closest(".msg-variant-switch");
      const nodeId=switchEl&&switchEl.dataset.node;
      if(nodeId)switchVariant(nodeId,act==="prevVariant"?-1:1);
    }
    return;
  }
  const bubble=e.target.closest(".bubble");
  if(bubble){
    const msgEl=bubble.closest(".message");
    if(msgEl){
      const wasOpen=msgEl.classList.contains("acted");
      document.querySelectorAll(".message.acted").forEach(el=>el.classList.remove("acted"));
      if(!wasOpen)msgEl.classList.add("acted");
    }
  }
});
$("ollamaKeyInput").addEventListener("input",e=>{
  state.ollamaKey=e.target.value.trim();save();
});
$("ollamaKeyInput").addEventListener("change",e=>{
  if(state.ollamaKey)verifyOllamaKey();else updateSearchUI();
});
$("saveKeyBtn").onclick=()=>{
  // Save only — no network check. For when the tester/API is flaky.
  state.ollamaKey=$("ollamaKeyInput").value.trim();save();
  state._ollamaVerified=false;
  const st=$("keyStatus");
  if(st){
    st.className="key-status ok";
    st.textContent=state.ollamaKey?"Key saved ✓":(state.searchProvider==="free"?"Free search (Bing / Google News)":"No key — free search");
  }
};
$("verifyOllamaBtn").onclick=verifyOllamaKey;
$("wsEnabled").onchange=e=>{state.wsEnabled=e.target.checked;save();updateWorkspaceUI()}
$("wsPick").onclick=()=>{if(window.Android&&Android.openWorkspacePicker)Android.openWorkspacePicker();else alert("Available in the Android app.")}
$("wsClear").onclick=()=>{if(window.Android&&Android.clearWorkspace){Android.clearWorkspace()}state.wsEnabled=false;state.projectName=(window.Android&&Android.hasProject&&Android.hasProject())?Android.getProjectName():"";save();updateWorkspaceUI();render()}
$("saveSettings").onclick=async()=>{
  state.base=$("baseUrl").value.trim();state.key=$("apiKey").value.trim();save();
  const btn=$("saveSettings");btn.disabled=true;const label=btn.textContent;btn.textContent="Saving…";
  try{await fetchModels(true)}finally{btn.disabled=false;btn.textContent=label}
}
$("refreshModels").onclick=()=>fetchModels()
$("sheetScrim").onclick=closeSheets
$("contextBtn").onclick=()=>{
  openSheet("contextSheet");
  const lim=getCtxLimits();
  $("inputTokens").value=lim.input;$("outputTokens").value=lim.output;
  $("autoCompact").checked=state.settings.auto;$("threshold").value=state.settings.threshold;
  $("perModelCtx").checked=isModelOverridden();
  renderUsagePanel();
  const note=$("ctxModelNote");
  if(note){
    note.textContent=isModelOverridden()
      ?"Per-model settings: "+(state.selected||"unknown")
      :"Global defaults (all models) — "+(state.selected?"current: "+state.selected:"no model selected");
    note.classList.toggle("on",isModelOverridden());
  }
}
$("perModelCtx").onchange=e=>{
  const note=$("ctxModelNote");
  if(note){
    note.textContent=e.target.checked
      ?"Per-model settings: "+(state.selected||"unknown")
      :"Global defaults (all models) — "+(state.selected?"current: "+state.selected:"no model selected");
    note.classList.toggle("on",e.target.checked);
  }
}
$("saveContext").onclick=()=>{
  const input=Number($("inputTokens").value)||128000;
  const output=Number($("outputTokens").value)||6000;
  if($("perModelCtx").checked&&state.selected){
    if(!state.modelContext)state.modelContext={};
    state.modelContext[state.selected]={input,output};
  }else{
    state.settings.input=input;
    state.settings.output=output;
    if(state.selected&&state.modelContext&&state.modelContext[state.selected])delete state.modelContext[state.selected];
  }
  state.settings.auto=$("autoCompact").checked;
  state.settings.threshold=Number($("threshold").value)||80;
  save();renderCtxRing();closeSheets();
}
$("compactNow").onclick=()=>compactNow(true)
$("ctxRingBtn").onclick=()=>$("contextBtn").onclick()
$("sendBtn").onclick=()=>{
  if($("sendBtn").classList.contains("stop")){cancelActiveStream();return}
  send();
}
$("input").addEventListener("input",resizeInput)
$("input").addEventListener("input",updateSlashMenu)
$("input").addEventListener("keydown",e=>{if(e.key==="Escape"){$("slashMenu").classList.remove("show")}})
$("input").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}})
initProjectState();render();renderAttachments();resizeInput();updateModelBtn();renderCtxRing();renderRecent();loadExtensions();
// Restore an in-flight turn that died mid-flight (crash, renderer kill, app kill):
// surface it as a message bubble so the user can hit "continue" with full context.
try{
  const rawDraft=localStorage.getItem("turnDraft");
  if(rawDraft){
    const d=JSON.parse(rawDraft);
    if(d&&(d.text||d.thinking)&&Date.now()-(d.ts||0)<36e5){
      const parts=[];
      if(d.thinking)parts.push("<think>"+d.thinking+"</think>");
      if(d.text)parts.push(d.text);
      const m={id:"draft-"+Date.now(),role:"assistant",text:parts.join("\n\n"),ts:d.ts||Date.now(),
        meta:"￰ﾟﾑﾌ Restore after disconnect"};
      state.messages.push(m);save();render();
      localStorage.removeItem("turnDraft");
    }
  }
}catch(e){}
{const c=$("chat");if(c)lastChatClientHeight=c.clientHeight}

/* ── Keyboard-aware scrolling ───────── */
// The native WebView padding handles the layout resize itself (shrinks
// .chat's clientHeight when the keyboard opens). If we're stuck to bottom,
// just re-pin to the latest message. Otherwise .chat's visible height
// shrinks around the reader's current position without moving scrollTop —
// whatever they were reading at the bottom edge gets covered by the
// keyboard/composer. Track the last known clientHeight (declared near the
// top of the file, initialized once .chat first exists) and shift scrollTop
// by the delta so the same content stays in view.
function syncKeyboard(){
  const c=$("chat");
  if(!c)return;
  if(stickToBottom){scrollToBottom(false);lastChatClientHeight=c.clientHeight;return}
  if(lastChatClientHeight!=null){
    const delta=lastChatClientHeight-c.clientHeight;
    if(delta>0)c.scrollTop=c.scrollTop+delta;
  }
  lastChatClientHeight=c.clientHeight;
}
window.visualViewport&&window.visualViewport.addEventListener("resize",syncKeyboard);
window.addEventListener("resize",syncKeyboard);
// Called directly from Kotlin right after the --sys-ime CSS var is applied —
// CSS var writes don't reliably fire the browser resize events above, which
// is why compensation used to only kick in on the second keyboard toggle.
window.__syncKeyboard=syncKeyboard;
// Lock the page pan dead. Native scrolling is allowed ONLY when the touch
// started inside an element that can actually scroll right now (chat feed,
// sheets, code blocks, an overflowing textarea). Everything else — especially
// the composer and its textarea — stays glued in place.
const SCROLLABLE=".chat,.sheet,#recent,.console-out,textarea,pre";
document.addEventListener("touchmove",e=>{
  let el=e.target;
  while(el&&el!==document.body){
    if(el.matches&&el.matches(SCROLLABLE)){
      const cs=getComputedStyle(el);
      if(cs.overflowY==="auto"||cs.overflowY==="scroll"){
        if(el.scrollHeight>el.clientHeight+4)return;  // it really can scroll
      }
    }
    el=el.parentElement;
  }
  e.preventDefault();
},{passive:false});
