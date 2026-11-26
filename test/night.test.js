import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNightStore } from '../src/night.js';

const entry = (username, id, title = `Example ${id}`, rating = 4) => ({tmdbId:String(id),title,year:2020,entryUrl:`https://letterboxd.com/${username}/film/example-${id}/`,rating,watchedDate:'2020-01-01',liked:true,rewatch:false});
function fixture(collect = async username => ({complete:true,recent:[entry(username,1),entry(username,username==='alice'?2:3)],checks:{}}), options={}) {
  const jobs=[];
  const store=createNightStore({...options,collect,startJob:job=>{jobs.push(Promise.resolve().then(job));return true;}});
  const host=store.create({username:'alice',consent:true});
  const join=(username='bob')=>store.join(host.room.id,{username,consent:true});
  return {store,host,join,jobs};
}
function error(status, run) {assert.throws(run, value=>value.status===status);}

test('room supports 2–6 consenting unique members and hides private voting keys',()=>{
 const {store,host,join}=fixture();
 try {
  error(400,()=>store.create({username:'x'}));
  error(400,()=>store.start(host.room.id,host.token));
  error(409,()=>join('ALICE'));
  const friend=join();
  error(403,()=>store.start(host.room.id,friend.token));
  error(403,()=>store.peek(host.room.id,'wrong'));
  const publicView=store.peek(host.room.id);
  assert.equal(publicView.members,undefined);assert.equal(publicView.movies,undefined);
  assert.equal(JSON.stringify(store.peek(host.room.id,friend.token)).includes(host.token),false);
  for(const username of ['c','d','e','f'])join(username);
  assert.equal(store.peek(host.room.id,host.token).members.length,6);
  error(409,()=>join('g'));
 }finally{store.close();}
});

test('sequential collection merges shared films, preserves latest entry and produces a real vote tie/winner',async()=>{
 let active=0,maximum=0;
 const {store,host,join,jobs}=fixture(async username=>{
  active++;maximum=Math.max(maximum,active);await Promise.resolve();active--;
  return {complete:true,recent:username==='alice'?[entry(username,1,'Shared',5),entry(username,1,'Shared',2),entry(username,2)]:[entry(username,1,'Shared'),entry(username,3)]};
 });
 try {
  const friend=join();store.start(host.room.id,host.token);await jobs[0];
  let room=store.peek(host.room.id,host.token);
  assert.equal(maximum,1);assert.equal(room.state,'ready');assert.equal(room.movies.length,3);
  const shared=room.movies.find(m=>m.title==='Shared');assert.equal(shared.loggedBy.length,2);assert.equal(shared.loggedBy[0].rating,5);
  const other=room.movies.find(m=>m.id!==shared.id);
  store.nominate(room.id,host.token,shared.id);store.nominate(room.id,friend.token,other.id);
  store.vote(room.id,host.token,shared.id);room=store.vote(room.id,friend.token,other.id);
  assert.equal(room.outcome.kind,'tie');assert.equal(room.votesCast,2);
  room=store.vote(room.id,friend.token,shared.id);assert.equal(room.outcome.kind,'winner');assert.equal(room.nominations.find(n=>n.filmId===shared.id).votes,2);
  store.vote(room.id,friend.token,shared.id);assert.equal(store.peek(room.id,host.token).votesCast,2);
  error(400,()=>store.vote(room.id,host.token,'unknown'));
  error(409,()=>join('late'));
 }finally{store.close();}
});

test('a block stops remaining feeds and marks partial data without inventing entries',async()=>{
 let calls=0;
 const {store,host,join,jobs}=fixture(async username=>{calls++;return username==='alice'?{complete:true,recent:[entry(username,1)]}:{complete:false,recent:[],checks:{recent:{blocked:true}}};});
 try {
  join();join('carol');store.start(host.room.id,host.token);await jobs[0];
  const room=store.peek(host.room.id,host.token);assert.equal(room.state,'partial');assert.equal(calls,2);
  assert.deepEqual(room.members.map(p=>p.feedState),['available','blocked','not-requested']);assert.equal(room.movies.length,1);
 }finally{store.close();}
});

for(const complete of [true,false])test(`empty and unavailable feeds remain distinct: ${complete}`,async()=>{
 const {store,host,join,jobs}=fixture(async()=>({complete,recent:[],checks:{}}));
 try {join();store.start(host.room.id,host.token);await jobs[0];const room=store.peek(host.room.id,host.token);assert.equal(room.state,complete?'ready':'failed');assert.equal(room.movies.length,0);assert.equal(room.members[0].feedState,complete?'empty':'unavailable');error(complete?400:409,()=>store.nominate(room.id,host.token,'film-1'));}
 finally{store.close();}
});

test('expiry cannot be extended by reads, votes or joins and deletes the room',()=>{
 let time=100;
 const {store,host,join}=fixture(undefined,{now:()=>time,ttlMs:1000});
 try {time+=600;join();assert.equal(store.peek(host.room.id,host.token).expiresInMs,400);time+=400;error(410,()=>store.peek(host.room.id,host.token));error(410,()=>join());}
 finally{store.close();}
});

test('ending a room aborts active work and late results cannot resurrect it',async()=>{
 let started,wasAborted=false;
 const begun=new Promise(resolve=>{started=resolve;});
 const {store,host,join,jobs}=fixture(async(username,{signal})=>{started();await new Promise(resolve=>signal.addEventListener('abort',()=>{wasAborted=true;resolve();},{once:true}));return {complete:true,recent:[entry(username,1)]};});
 join();store.start(host.room.id,host.token);await begun;store.end(host.room.id,host.token);await jobs[0];assert.equal(wasAborted,true);error(410,()=>store.peek(host.room.id,host.token));store.close();
});

test('shortlist and per-person limits are enforced without recording extra votes',async()=>{
 const {store,host,join,jobs}=fixture(async username=>({complete:true,recent:Array.from({length:8},(_,i)=>entry(username,i+1))}));
 try {const b=join(),c=join('carol');store.start(host.room.id,host.token);await jobs[0];const movies=store.peek(host.room.id,host.token).movies;
  for(const [who,offset]of [[host,0],[b,2],[c,4]])for(const film of movies.slice(offset,offset+2))store.nominate(host.room.id,who.token,film.id);
  error(409,()=>store.nominate(host.room.id,host.token,movies[6].id));assert.equal(store.peek(host.room.id,host.token).nominations.length,6);
 }finally{store.close();}
});


test('the same film merges when an optional TMDB identifier is missing',async()=>{
 const {store,host,join,jobs}=fixture(async username=>{const film=entry(username,1);if(username==='bob')delete film.tmdbId;return {complete:true,recent:[film]};});
 try {join();store.start(host.room.id,host.token);await jobs[0];const room=store.peek(host.room.id,host.token);assert.equal(room.movies.length,1);assert.equal(room.movies[0].loggedBy.length,2);assert.equal(room.movies[0].aliases,undefined);}
 finally{store.close();}
});

test('unknown liked/rewatch flags stay unknown instead of becoming false',async()=>{
 const collect=async username=>({complete:true,recent:[{...entry(username,1),liked:null,rewatch:null}],checks:{}});
 const {store,host,join,jobs}=fixture(collect);
 try {
  join(); store.start(host.room.id,host.token); await Promise.all(jobs);
  const film=store.peek(host.room.id,host.token).movies[0];
  assert.deepEqual(film.loggedBy.map(({liked,rewatch})=>[liked,rewatch]),[[null,null],[null,null]]);
 }finally{store.close();}
});
