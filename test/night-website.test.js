import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.js';
import {launchOwnedBrowser} from '../src/snapshot.js';
let browser;
before(async()=>{browser=await launchOwnedBrowser();});
after(async()=>{await browser?.close();});
const film=(user,id,title)=>({tmdbId:String(id),title,year:2020,entryUrl:`https://letterboxd.com/${user}/film/example-${id}/`,rating:4.5,liked:true,rewatch:false,watchedDate:'2020-01-01'});
const collect=async user=>({complete:true,recent:[film(user,1,'Shared example'),film(user,user==='alice'?2:3,user==='alice'?'Alice example':'Bob example')],checks:{}});
async function withServer(run,options={}) {
 const server=createApp({collect,...options});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await run(`http://127.0.0.1:${server.address().port}`);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
async function enter(page,base,user,fragment='') {
 await page.goto(base+'/night'+fragment);
 await page.getByLabel('Your Letterboxd username',{exact:true}).fill(user);
 await page.locator('#permission').check();
 await page.getByRole('button',{name:fragment?'Join room':'Create room',exact:true}).click();
 await page.locator('#room').waitFor({state:'visible'});
}
async function waitFor(page,selector,text) {await page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent.includes(text),{selector,text});}

test('two isolated browsers share a constellation, shortlist, changing votes and room destruction',async()=>{
 await withServer(async base=>{
  const a=await browser.newPage(),b=await browser.newPage();let pageError=false;
  for(const p of [a,b])p.on('pageerror',()=>{pageError=true;});
  try {
   await enter(a,base,'alice');const link=await a.locator('#invite-link').inputValue();const roomId=new URL(link).hash.slice(1);
   assert.equal(new URL(link).search,'');
   assert.equal(await a.locator('#start-night').isDisabled(),true);
   await enter(b,base,'bob','#'+roomId);
   await a.waitForFunction(()=>!document.querySelector('#start-night').disabled);
   await a.getByRole('button',{name:'Collect feeds',exact:true}).click();
   for(const p of [a,b])await p.locator('#explore').waitFor({state:'visible'});
   assert.equal(await a.locator('.friend-node').count(),2);assert.equal(await a.locator('.film-node').count(),3);assert.equal(await a.locator('.connection').count(),4);
   const graphNode=a.locator('.film-node').first();const focusedId=await graphNode.getAttribute('data-film-id');
   await graphNode.focus();await graphNode.press('Enter');
   await a.waitForResponse(r=>r.url().includes('/api/night/')&&r.request().method()==='GET');
   assert.equal(await a.evaluate(()=>document.activeElement?.getAttribute('data-film-id')),focusedId);
   await a.locator('#candidates .candidate').filter({hasText:'Shared example'}).click();
   assert.match(await a.locator('#film-detail').innerText(),/@alice.*4.5\/5/);
   await a.getByRole('button',{name:'Add to shortlist',exact:true}).click();
   await waitFor(b,'#nominees','Shared example');
   await b.locator('#candidates .candidate').filter({hasText:'Bob example'}).click();await b.getByRole('button',{name:'Add to shortlist',exact:true}).click();
   await waitFor(a,'#nominees','Bob example');
   await a.getByRole('button',{name:'Vote for Shared example',exact:true}).click();
   await b.getByRole('button',{name:'Vote for Bob example',exact:true}).click();
   await waitFor(a,'#outcome','Tied');await waitFor(b,'#outcome','Tied');
   await b.getByRole('button',{name:'Vote for Shared example',exact:true}).click();
   await waitFor(a,'#outcome','Tonight’s pick: Shared example');
   assert.match(await a.locator('#vote-summary').innerText(),/2 of 2/);
   for(const width of [320,390,768,1440]){await a.setViewportSize({width,height:900});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
   for(const p of [a,b])assert.deepEqual(await p.evaluate(async()=>({local:localStorage.length,session:sessionStorage.length,cookie:document.cookie,caches:await caches.keys()})),{local:0,session:0,cookie:'',caches:[]});
   await b.getByRole('button',{name:'End room',exact:true}).click();
   await a.locator('#room').waitFor({state:'hidden'});
   assert.equal(await a.locator('#constellation').textContent(),'');assert.equal(await a.locator('#night-username').inputValue(),'');assert.equal(await a.locator('#invite-link').inputValue(),'');
   assert.equal((await fetch(`${base}/api/night/${roomId}`)).status,410);
   assert.equal(pageError,false);
  }finally{await a.close();await b.close();}
 });
});

test('six friends collect and vote, a seventh is rejected, and navigation ends the room',async()=>{
 await withServer(async base=>{
  const pages=[];
  try{
   const host=await browser.newPage();pages.push(host);await enter(host,base,'user1');const id=new URL(await host.locator('#invite-link').inputValue()).hash.slice(1);
   await Promise.all(Array.from({length:5},async(_,index)=>{const page=await browser.newPage();pages.push(page);await enter(page,base,`user${index+2}`,'#'+id);}));
   assert.equal(new Set(pages.map(page=>page.context())).size,6);
   await host.waitForFunction(()=>document.querySelectorAll('#members .member').length===6);
   const response=await fetch(`${base}/api/night/${id}/join`,{method:'POST',body:JSON.stringify({username:'seventh',consent:true})});assert.equal(response.status,409);
   await host.getByRole('button',{name:'Collect feeds',exact:true}).click();
   await host.locator('#explore').waitFor({state:'visible'});
   assert.equal(await host.locator('.friend-node').count(),6);
   await host.locator('#candidates .candidate').first().click();
   await host.getByRole('button',{name:'Add to shortlist',exact:true}).click();
   await Promise.all(pages.map(async page=>{await page.locator('#nominees button').first().waitFor({state:'visible'});await page.locator('#nominees button').first().click();}));
   await waitFor(host,'#outcome','Tonight’s pick:');
   assert.match(await host.locator('#vote-summary').innerText(),/6 of 6/);
   await pages[1].goto(base+'/');
   await host.locator('#room').waitFor({state:'hidden'});assert.equal((await fetch(`${base}/api/night/${id}`)).status,410);
  }finally{for(const page of pages)await page.close();}
 });
});

test('expiry removes room content and clears the invite from the browser URL',async()=>{
 await withServer(async base=>{
  const page=await browser.newPage();
  try{
   await enter(page,base,'alice');const id=new URL(await page.locator('#invite-link').inputValue()).hash.slice(1);
   await page.locator('#room').waitFor({state:'hidden',timeout:5000});
   assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('#members').textContent(),'');
   assert.equal((await fetch(`${base}/api/night/${id}`)).status,410);
  }finally{await page.close();}
 },{nightOptions:{ttlMs:1500}});
});

test('room endpoints enforce authorization, same-origin writes and no-store responses',async()=>{
 await withServer(async base=>{
  const created=await fetch(base+'/api/night',{method:'POST',body:JSON.stringify({username:'alice',consent:true})});assert.equal(created.headers.get('cache-control'),'no-store');const a=await created.json();
  const b=await (await fetch(`${base}/api/night/${a.room.id}/join`,{method:'POST',body:JSON.stringify({username:'bob',consent:true})})).json();
  assert.equal((await fetch(`${base}/api/night/${a.room.id}/vote`,{method:'POST',body:JSON.stringify({filmId:'film-1'})})).status,403);
  assert.equal((await fetch(`${base}/api/night/${a.room.id}/start`,{method:'POST',headers:{Authorization:`Bearer ${b.token}`},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/night',{method:'POST',headers:{Origin:'https://other.invalid'},body:'{}'})).status,403);
 });
});


for (const mode of ['empty','blocked','unavailable']) test(`room UI distinguishes feed state: ${mode}`,async()=>{
 await withServer(async base=>{
  const a=await browser.newPage(),b=await browser.newPage();
  try {
   await enter(a,base,'alice');const id=new URL(await a.locator('#invite-link').inputValue()).hash.slice(1);await enter(b,base,'bob','#'+id);
   await a.waitForFunction(()=>!document.querySelector('#start-night').disabled);await a.getByRole('button',{name:'Collect feeds',exact:true}).click();
   if(mode==='empty'){
    await a.locator('#explore').waitFor({state:'visible'});await a.locator('#graph-empty').waitFor({state:'visible'});assert.equal(await a.locator('.film-node').count(),0);assert.match(await a.locator('#members').innerText(),/No recent movie entries/);
   }else if(mode==='blocked'){
    await a.locator('#explore').waitFor({state:'visible'});assert.match(await a.locator('#night-status').innerText(),/Only verified entries/);assert.match(await a.locator('#members').innerText(),/Blocked/);assert.equal(await a.locator('.film-node').count(),1);
   }else{
    await waitFor(a,'#night-status','No feeds could be collected');assert.equal(await a.locator('#explore').isHidden(),true);assert.match(await a.locator('#members').innerText(),/Unavailable/);
   }
   await a.getByRole('button',{name:'End room',exact:true}).click();await b.locator('#room').waitFor({state:'hidden'});
  }finally{await a.close();await b.close();}
 },{collect:async user=>mode==='empty'?{complete:true,recent:[]}:mode==='blocked'&&user==='alice'?{complete:true,recent:[film(user,1,'Verified example')]}:{complete:false,recent:[],checks:{recent:{blocked:mode==='blocked'}}}});
});


test('room batches share the solo collector lock and release it after cancellation',async()=>{
 let release,signal;
 await withServer(async base=>{
  const post=async(path,body={},token)=>fetch(base+path,{method:'POST',headers:token?{Authorization:`Bearer ${token}`}:{},body:JSON.stringify(body)});
  const a=await (await post('/api/night',{username:'alice',consent:true})).json();
  await post(`/api/night/${a.room.id}/join`,{username:'bob',consent:true});
  assert.equal((await post(`/api/night/${a.room.id}/start`,{},a.token)).status,202);
  while(!signal)await new Promise(r=>setTimeout(r,10));
  assert.equal((await post('/api/collect',{username:'carol'})).status,429);
  const c=await (await post('/api/night',{username:'carol',consent:true})).json();
  await post(`/api/night/${c.room.id}/join`,{username:'david',consent:true});
  assert.equal((await post(`/api/night/${c.room.id}/start`,{},c.token)).status,429);
  await post(`/api/night/${a.room.id}/leave`,{},a.token);
  assert.equal(signal.aborted,true);release();
  await new Promise(r=>setTimeout(r,10));
  assert.equal((await post(`/api/night/${c.room.id}/start`,{},c.token)).status,202);
 },{collect:async(user,options)=>{if(user==='alice'){signal=options.signal;await new Promise(r=>{release=r;});}return {complete:true,recent:[]};}});
});


test('a duplicate join can recover in the same browser without creating another member',async()=>{
 await withServer(async base=>{
  const a=await browser.newPage(),b=await browser.newPage();
  try {
   await enter(a,base,'alice');const id=new URL(await a.locator('#invite-link').inputValue()).hash.slice(1);
   await b.goto(base+'/night#'+id);await b.locator('#night-username').fill('ALICE');await b.locator('#permission').check();await b.locator('#enter-room').click();
   await waitFor(b,'#night-status','already joined');assert.equal(await b.locator('#room').isHidden(),true);assert.equal(await b.locator('#enter-room').isEnabled(),true);
   await b.locator('#night-username').fill('bob');await b.locator('#enter-room').click();await b.locator('#room').waitFor({state:'visible'});
   await a.waitForFunction(()=>document.querySelectorAll('#members .member').length===2);
   await b.locator('#leave-room').click();await a.locator('#room').waitFor({state:'hidden'});
  } finally {await a.close();await b.close();}
 });
});

test('all six sessions expire after voting and a delayed response cannot restore their data',async()=>{
 await withServer(async base=>{
  const pages=[];let release;
  const held=new Promise(resolve=>{release=resolve;});
  try {
   const host=await browser.newPage();pages.push(host);await enter(host,base,'friend1');
   const id=new URL(await host.locator('#invite-link').inputValue()).hash.slice(1);
   await Promise.all(Array.from({length:5},async(_,i)=>{const p=await browser.newPage();pages.push(p);await enter(p,base,`friend${i+2}`,'#'+id);}));
   await host.waitForFunction(()=>document.querySelectorAll('#members .member').length===6);
   await host.locator('#start-night').click();await host.locator('#explore').waitFor({state:'visible'});
   await host.locator('#candidates button').first().click();await host.getByRole('button',{name:'Add to shortlist',exact:true}).click();
   await Promise.all(pages.map(async p=>{await p.locator('#nominees button').first().waitFor({state:'visible'});await p.locator('#nominees button').first().click();}));
   await waitFor(host,'#vote-summary','6 of 6');
   let captured;
   const gotResponse=new Promise(resolve=>{captured=resolve;});
   await pages[1].route(`**/api/night/${id}`,async route=>{
    if(route.request().method()!=='GET'){await route.continue();return;}
    const response=await route.fetch();captured();await held;
    try{await route.fulfill({response});}catch{}
   });
   await gotResponse;
   await Promise.all(pages.map(p=>p.locator('#room').waitFor({state:'hidden',timeout:18000})));
   release();await pages[1].unrouteAll({behavior:'wait'});
   // A browser-side round trip flushes the released stale response before assertions.
   await pages[1].evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   for(const p of pages){assert.equal(await p.locator('#room').isHidden(),true);assert.equal(new URL(p.url()).hash,'');for(const selector of ['#members','#constellation','#candidates','#nominees','#film-detail','#outcome'])assert.equal(await p.locator(selector).textContent(),'');for(const selector of ['#night-username','#invite-link','#film-search'])assert.equal(await p.locator(selector).inputValue(),'');}
   assert.equal((await fetch(`${base}/api/night/${id}`)).status,410);
   assert.equal((await fetch(`${base}/api/night/${id}/join`,{method:'POST',body:JSON.stringify({username:'late',consent:true})})).status,410);
  } finally {release();for(const p of pages)await p.close();}
 },{nightOptions:{ttlMs:12000}});
});

test('expiry during six-friend loading aborts collection, skips later feeds and releases the lock',async()=>{
 let calls=0,aborted=false;
 await withServer(async base=>{
  const pages=[];
  try {
   const host=await browser.newPage();pages.push(host);await enter(host,base,'slow1');
   const id=new URL(await host.locator('#invite-link').inputValue()).hash.slice(1);
   await Promise.all(Array.from({length:5},async(_,i)=>{const page=await browser.newPage();pages.push(page);await enter(page,base,`slow${i+2}`,'#'+id);}));
   await host.waitForFunction(()=>document.querySelectorAll('#members .member').length===6);await host.locator('#start-night').click();
   await waitFor(host,'#members','Collecting feed');
   await Promise.all(pages.map(page=>page.locator('#room').waitFor({state:'hidden',timeout:12000})));
   assert.equal(aborted,true);assert.equal(calls,1);
   for(const page of pages){assert.equal(await page.locator('#constellation').textContent(),'');assert.equal(await page.locator('#members').textContent(),'');assert.equal(await page.locator('#invite-link').inputValue(),'');assert.equal(new URL(page.url()).hash,'');}
   assert.equal((await fetch(`${base}/api/night/${id}`)).status,410);
   const retry=await fetch(base+'/api/collect',{method:'POST',body:JSON.stringify({username:'afterexpiry'})});assert.equal(retry.status,200);assert.equal((await retry.json()).complete,true);
  } finally {for(const page of pages)await page.close();}
 },{nightOptions:{ttlMs:7000},collect:async(user,{signal})=>{
  if(user==='afterexpiry')return {complete:true,recent:[]};
  calls++;await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
  return {complete:true,recent:[film(user,1,'Late synthetic film')]};
 }});
});
