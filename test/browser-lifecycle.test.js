import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Synthetic pages only. A leaked BrowserServer listener must fail, not hang CI.
test('owned browser cleanup permits natural process exit after repeated sessions',async()=>{
 const source=`
  import {launchOwnedBrowser} from './src/snapshot.js';
  const deadline=setTimeout(()=>process.exit(1),30000);deadline.unref();
  for(let i=0;i<10;i++){
   const browser=await launchOwnedBrowser();
   try {await Promise.all(Array.from({length:6},async()=>{const page=await browser.newPage({acceptDownloads:false,serviceWorkers:'block'});await page.goto('data:text/html,<p>Synthetic lifecycle fixture</p>');}));}
   finally {await browser.close();}
  }
 `;
 const result=await new Promise(resolve=>execFile(process.execPath,['--input-type=module','-e',source],{cwd:fileURLToPath(new URL('../',import.meta.url)),timeout:40000},error=>resolve(!error)));
 assert.equal(result,true,'Owned browser cleanup left resources open or failed to finish.');
});

// Exercise the same checker and six UI contexts as a live run, using only fixtures.
test('six-session checker completes and exits after voting without retaining a listener',async()=>{
 const {createApp}=await import('../src/server.js');
 const server=createApp({collect:async user=>({complete:true,recent:Array.from({length:50},(_,i)=>({title:`Synthetic film ${i}`,year:2020,tmdbId:String(i),entryUrl:`https://letterboxd.com/${user}/film/fixture-${i}/`,rating:4}))})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const result=await new Promise(resolve=>execFile(process.execPath,['scripts/test-night-live.mjs','friend1','friend2','friend3','friend4','friend5','friend6'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,TEST_URL:`http://127.0.0.1:${server.address().port}`},timeout:40000},error=>resolve(error?.code||0)));
  assert.equal(result,0,'The synthetic six-session checker did not shut down cleanly.');
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
