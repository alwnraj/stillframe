// Live data is used only in request/view memory. Exit status only; no artifacts.
import assert from 'node:assert/strict';
import { launchOwnedBrowser } from '../src/snapshot.js';
const args=process.argv.slice(2);
const expire=args.includes('--expire');
const usernames=args.filter(value=>value!=='--expire');
const base=process.env.TEST_URL||'http://127.0.0.1:3000';
let browser,host,roomId,secret,createdAt,stage=10;
const deadline=setTimeout(()=>{
 process.exitCode=stage;
 setTimeout(()=>process.exit(stage),10000);
 if(browser)void browser.close().finally(()=>process.exit(stage));else process.exit(stage);
},165000);
async function readRoom() {
 const response=await fetch(`${base}/api/night/${roomId}`,{headers:{Authorization:`Bearer ${secret}`},cache:'no-store',signal:AbortSignal.timeout(5000)});
 assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.status,200);return response.json();
}
async function assertCleared(page) {
 await page.locator('#room').waitFor({state:'hidden',timeout:15000});
 assert.equal(new URL(page.url()).hash,'');
 for(const selector of ['#members','#constellation','#candidates','#nominees','#film-detail','#outcome'])assert.equal(await page.locator(selector).textContent(),'');
 for(const selector of ['#night-username','#invite-link','#film-search'])assert.equal(await page.locator(selector).inputValue(),'');
}
try {
 assert.ok(usernames.length>=2&&usernames.length<=6);
 assert.equal(new Set(usernames.map(value=>value.toLowerCase())).size,usernames.length);
 browser=await launchOwnedBrowser();host=await browser.newPage({acceptDownloads:false,serviceWorkers:'block'});
 const pages=[host];let pageError=false,unsafeCache=false;
 async function join(page,username,fragment='') {
  page.on('pageerror',()=>{pageError=true;});
  page.on('response',response=>{if(response.url().startsWith(base+'/api/night')&&response.headers()['cache-control']!=='no-store')unsafeCache=true;});
  await page.goto(base+'/night'+fragment);await page.getByLabel('Your Letterboxd username',{exact:true}).fill(username);await page.locator('#permission').check();
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&(r.url().endsWith('/api/night')||r.url().endsWith('/join')));
  await page.getByRole('button',{name:fragment?'Join room':'Create room',exact:true}).click();
  const response=await pending;assert.equal(response.status(),201);const data=await response.json();assert.ok(data.token&&data.room);
  await page.locator('#room').waitFor({state:'visible'});return data;
 }
 createdAt=performance.now();
 const created=await join(host,usernames[0]);roomId=created.room.id;secret=created.token;
 await Promise.all(usernames.slice(1).map(async username=>{const page=await browser.newPage({acceptDownloads:false,serviceWorkers:'block'});pages.push(page);await join(page,username,'#'+roomId);}));
 assert.equal(new Set(pages.map(page=>page.context())).size,usernames.length);
 await host.waitForFunction(count=>document.querySelectorAll('#members .member').length===count,usernames.length);
 stage=11;
 await host.getByRole('button',{name:'Collect feeds',exact:true}).click();
 await host.waitForFunction(()=>!document.querySelector('#explore').hidden||document.querySelector('#night-status').textContent.includes('No feeds could')||document.querySelector('#room').hidden,{},{timeout:115000});
 const room=await readRoom();
 if(room.members.some(p=>p.feedState==='blocked'))process.exitCode=2;
 else if(room.state==='partial'||room.state==='failed')process.exitCode=3;
 assert.equal(room.state,'ready');assert.ok(room.movies.length>0);assert.equal(room.members.length,usernames.length);
 assert.ok(room.members.every(person=>['available','empty'].includes(person.feedState)));
 for(const page of pages){await page.locator('#explore').waitFor({state:'visible'});assert.equal(await page.locator('.friend-node').count(),usernames.length);}
 stage=12;
 await host.locator('#candidates .candidate').first().click();await host.getByRole('button',{name:'Add to shortlist',exact:true}).click();
 await Promise.all(pages.map(async page=>{const button=page.locator('#nominees button').first();await button.waitFor({state:'visible'});await button.click();}));
 for(const page of pages)await page.waitForFunction(count=>document.querySelector('#outcome').textContent.startsWith('Tonight’s pick:')&&document.querySelector('#vote-summary').textContent.startsWith(`${count} of ${count}`),usernames.length);
 // A changed vote must replace the previous vote, never add another ballot.
 if(room.movies.length>1){
  await host.locator('#candidates .candidate').nth(1).click();await host.getByRole('button',{name:'Add to shortlist',exact:true}).click();
  const changedResponse=host.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/vote'));
  await host.locator('#nominees article').nth(1).getByRole('button').click();assert.equal((await changedResponse).status(),200);
  const changed=await readRoom();assert.equal(changed.votesCast,usernames.length);assert.equal(changed.nominations.reduce((total,item)=>total+item.votes,0),usernames.length);assert.equal(changed.ownVote,changed.nominations[1].filmId);
  for(const page of pages)await page.waitForFunction(count=>{const votes=document.querySelectorAll('#nominees .nominee p');return votes.length===2&&votes[0].textContent===`${count-1} vote${count===2?'':'s'}`&&votes[1].textContent==='1 vote';},usernames.length);
 }
 for(const page of pages)assert.deepEqual(await page.evaluate(async()=>({local:localStorage.length,session:sessionStorage.length,cookies:document.cookie,caches:await caches.keys()})),{local:0,session:0,cookies:'',caches:[]});
 for(const width of [320,390,1440]){await host.setViewportSize({width,height:900});assert.ok(await host.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 if(expire){
  stage=13;
  const remaining=(await readRoom()).expiresInMs;
  await Promise.all(pages.map(page=>page.locator('#room').waitFor({state:'hidden',timeout:remaining+10000})));
  assert.ok(performance.now()-createdAt>=119000);
 }else{
  stage=14;await host.getByRole('button',{name:'End room',exact:true}).click();
 }
 for(const page of pages)await assertCleared(page);
 assert.equal((await fetch(`${base}/api/night/${roomId}`,{signal:AbortSignal.timeout(5000)})).status,410);
 const staleVote=await fetch(`${base}/api/night/${roomId}/vote`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({filmId:'film-1'}),signal:AbortSignal.timeout(5000)});
 assert.equal(staleVote.status,410);assert.equal(pageError,false);assert.equal(unsafeCache,false);
}catch{process.exitCode ||= stage;}
finally{
 // This unref'ed guard permits natural exit, but fails leaked listeners rather than hanging.
 setTimeout(()=>process.exit(process.exitCode||6),15000).unref();
 if(roomId&&secret)try{await fetch(`${base}/api/night/${roomId}/leave`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});}catch{}
 try{await browser?.close();}catch{process.exitCode ||= 6;}clearTimeout(deadline);
}
