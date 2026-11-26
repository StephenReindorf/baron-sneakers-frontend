/* Shared browser API client. Business rules and prices are enforced by server.js. */
const $=s=>document.querySelector(s);
const MIN_PAIRS=10;
const SIZES={40:'UK 6 / US 7',41:'UK 7 / US 8',42:'UK 8 / US 9',43:'UK 9 / US 10',44:'UK 10 / US 11',45:'UK 10.5 / US 11.5'};
const STAGES=['Awaiting payment','Paid','Sent to warehouse','Arrived at Tudu','Delivered'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const day=d=>new Date(d).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'});
const csrfToken=()=>{const m=document.cookie.match(/(?:^|; )baron\.csrf=([^;]*)/);return m?decodeURIComponent(m[1]):''};
const nativeFetch=fetch.bind(window);
window.fetch=(input,options={})=>{const method=String(options.method||'GET').toUpperCase();if(method==='GET'||method==='HEAD')return nativeFetch(input,options);const headers=new Headers(options.headers||{});if(!headers.has('x-csrf-token'))headers.set('x-csrf-token',csrfToken());return nativeFetch(input,{...options,headers})};
const request=async(url,options={})=>{const r=await fetch(url,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'Something went wrong.');return data};
let turnstileKey;
function loadTurnstile(){if(window.turnstile)return Promise.resolve();return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';s.async=true;s.onload=resolve;s.onerror=()=>reject(new Error('The security check could not be loaded.'));document.head.appendChild(s)})}
async function mountTurnstile(el){if(!el)return;if(turnstileKey===undefined)turnstileKey=(await request('/api/security')).turnstileSiteKey||'';if(!turnstileKey)return;await loadTurnstile();el.innerHTML='';el.dataset.wid=turnstile.render(el,{sitekey:turnstileKey})}
function turnstileToken(el){if(!turnstileKey||!el?.dataset.wid||!window.turnstile)return '';return turnstile.getResponse(el.dataset.wid)||''}
const Api={
 async products(){return request('/api/products')},
 async catalogueOptions(){return request('/api/catalogue-options')},
 async wholesale(){return request('/api/wholesale/products')},
 async wholesaleLogin(phone,accessCode,hp,turnstileToken){return request('/api/wholesale/login',{method:'POST',body:JSON.stringify({phone,accessCode,hp,turnstileToken})})},
 async order(o){return request('/api/orders',{method:'POST',body:JSON.stringify({hp:'',turnstileToken:'',...o,idempotencyKey:o.idempotencyKey||crypto.randomUUID()})})},
 async track(ref,last4,turnstileToken){return request('/api/track',{method:'POST',body:JSON.stringify({ref,last4,turnstileToken})})},
 async requestProduct(o){return request('/api/requests',{method:'POST',body:JSON.stringify({hp:'',...o})})},
 async arrivalDate(){return (await request('/api/arrival')).arrival},
 arrival(from=new Date()){const d=new Date(from);if(d.getUTCDay()===0||d.getUTCHours()>=17)d.setUTCDate(d.getUTCDate()+1);if(d.getUTCDay()===0)d.setUTCDate(d.getUTCDate()+1);d.setUTCDate(d.getUTCDate()+1);return d}
};
