/** A small layout preview before the unchanged official Web graph activates. */
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver';

// No messages, drafts or credentials enter this document. The browser reads
// only its existing layout and puts labels into textContent, never HTML.
export const WORKSPACE_BOOT_STYLE = `
#hapi-workspace-boot{position:fixed;inset:0;z-index:1000;display:flex;background:#fafafa;color:#242424;font:13px/1.5 system-ui,sans-serif;color-scheme:light dark}
#hapi-workspace-boot *{box-sizing:border-box}#hapi-workspace-boot aside{width:264px;padding:18px;border-right:1px solid #ddd;background:#f3f3f3}
#hapi-workspace-boot strong{font-size:15px}#hapi-workspace-boot small{display:block;color:#777;margin-top:5px}
#hapi-workspace-boot main{min-width:0;flex:1;display:flex;flex-direction:column}#hapi-workspace-boot header{height:46px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid #ddd}
#hapi-workspace-boot [data-boot-layout]{display:flex;flex:1;min-height:0;padding:5px;gap:5px}#hapi-workspace-boot [data-boot-split]{display:flex;flex:1;gap:5px;min-width:0;min-height:0}
#hapi-workspace-boot [data-boot-pane]{min-width:0;min-height:0;flex:1;border:1px solid #ddd;border-radius:8px;display:flex;align-items:center;justify-content:center;background:#fff;color:#888}
#hapi-workspace-boot footer{display:flex;gap:12px;padding:10px 16px;min-height:42px;border-top:1px solid #ddd;overflow:hidden}#hapi-workspace-boot footer span{white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}#hapi-workspace-boot [aria-current=true]{color:#111;font-weight:600}
#hapi-workspace-boot button{font:inherit;border:1px solid #bbb;border-radius:6px;padding:4px 10px;background:transparent;color:inherit;cursor:pointer}
@media(max-width:767px){#hapi-workspace-boot aside{display:none}}
@media(prefers-color-scheme:dark){#hapi-workspace-boot{background:#141414;color:#eee}#hapi-workspace-boot aside{background:#191919}#hapi-workspace-boot [data-boot-pane]{background:#1c1c1c}#hapi-workspace-boot aside,#hapi-workspace-boot header,#hapi-workspace-boot footer,#hapi-workspace-boot [data-boot-pane]{border-color:#333}#hapi-workspace-boot [aria-current=true]{color:#fff}}
`;

export const WORKSPACE_BOOT_SCRIPT = String.raw`(()=>{
  const entries=[...document.querySelectorAll('script[type="application/x-hapi-entry"]')];
  let released=false;
  const start=()=>{if(released)return;released=true;for(const original of entries){
    const script=document.createElement('script');
    for(const attribute of original.attributes)if(attribute.name!=='type')script.setAttribute(attribute.name,attribute.value);
    script.type='module';original.replaceWith(script);
  }};
  // Only the carrier's module start is scheduled. No upstream JS, module
  // registration, loader, scope or service implementation is changed.
  const release=()=>{if(document.visibilityState==='hidden')start();else{
    requestAnimationFrame(()=>requestAnimationFrame(start));setTimeout(start,250);
  }};
  try{
    if(new URL(location.href).searchParams.get('hapiBoot')==='off') {start();return;}
    const zh=(navigator.language||'').startsWith('zh');
    const tr=(en,cn)=>zh?cn:en;
    const root=document.createElement('div');root.id='hapi-workspace-boot';root.dataset.hapiWorkspaceBoot='layout';
    const make=(tag,text)=>{const element=document.createElement(tag);if(text)element.textContent=text;return element;};
    const aside=make('aside');aside.append(make('strong','HAPI'),make('small',tr('Restoring workspace','正在恢复工作区')));
    const main=make('main'),header=make('header'),status=make('span',tr('Preparing conversations…','正在准备会话…'));
    status.setAttribute('role','status');header.append(make('strong','HAPI'),status);
    const layout=make('div');layout.dataset.bootLayout='';
    const footer=make('footer');
    main.append(header,layout,footer);root.append(aside,main);
    let saved;
    try{const raw=localStorage.getItem('hapi-dsh:workspace:v1:'+location.origin+location.pathname);if(raw&&raw.length<=1048576)saved=JSON.parse(raw);}catch{}
    const windows=saved?.schemaVersion===1&&Array.isArray(saved.windows)&&saved.windows.length<=256?saved.windows:[];
    const active=windows.find(w=>w&&w.id===saved.activeWindowId);
    let count=0;
    const render=(node,depth=0)=>{
      if(!node||typeof node!=='object'||depth>32||++count>512)throw new Error('layout');
      if(node.type==='pane') {const pane=make('section',tr('Conversation','会话'));pane.dataset.bootPane='';return pane;}
      if(node.type!=='split'||!['horizontal','vertical'].includes(node.axis)||!Array.isArray(node.children)||node.children.length<2||node.children.length>128||!Array.isArray(node.weights)||node.weights.length!==node.children.length||!node.weights.every(w=>typeof w==='number'&&Number.isFinite(w)&&w>0))throw new Error('layout');
      const split=make('div');split.dataset.bootSplit='';split.style.flexDirection=node.axis==='horizontal'?'row':'column';
      node.children.forEach((child,index)=>{const element=render(child,depth+1);element.style.flex=node.weights[index]+' 1 0';split.append(element);});return split;
    };
    let searched=0;
    const find=(node,id,depth=0)=>{if(!node||depth>32||++searched>512)return;if(node.type==='pane')return node.id===id?node:undefined;if(Array.isArray(node.children))for(const child of node.children){const result=find(child,id,depth+1);if(result)return result;}};
    try{if(active){const node=saved.zoomed?.[active.id]?find(active.root,saved.focused?.[active.id]):active.root;layout.append(render(node));}}catch{layout.replaceChildren();}
    if(!layout.childElementCount){const pane=make('section',tr('Your workspace is starting','正在打开工作区'));pane.dataset.bootPane='';layout.append(pane);}
    for(const window of windows.slice(0,32)){if(!window||typeof window.name!=='string')continue;const tab=make('span',window.name.slice(0,200));if(window===active)tab.setAttribute('aria-current','true');footer.append(tab);}
    if(!footer.childElementCount)footer.append(make('span',tr('Workspace','工作区')));
    document.body.append(root);performance.mark('hapi:boot-layout');
    let disposed=false;
    const done=()=>{if(disposed)return;const workspace=document.querySelector('[data-hapi-workspace]');if(!workspace||!workspace.getClientRects().length)return;
      disposed=true;observer.disconnect();clearTimeout(timeout);root.remove();performance.mark('hapi:workspace-ready');};
    const observer=new MutationObserver(done);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','style','class']});
    const timeout=setTimeout(()=>{if(disposed)return;status.textContent=tr('Still connecting','仍在连接');const retry=make('button',tr('Reload','重新加载'));retry.onclick=()=>location.reload();header.append(retry);},15000);
    done();
  }catch{}finally{release();}
})()`;

export function workspaceBootInjections(): IndexInjection[] {
    return [{ kind: 'style', text: WORKSPACE_BOOT_STYLE }, { kind: 'script', placement: 'body', text: WORKSPACE_BOOT_SCRIPT }];
}

/** Supported Web carrier transform: give the layout one paint before starting
 * its existing entry module. Fall through unchanged on a different shell. */
export function deferWorkspaceEntry(html: string): string {
    if (!html.includes(WORKSPACE_BOOT_SCRIPT)) return html;
    return html.replace(/<script\b([^>]*\btype=["'])module(["'][^>]*\bsrc=["']\.\/assets\/index-[^"']+\.js["'][^>]*)><\/script>/g,
        '<script$1application/x-hapi-entry$2></script>');
}
