const $ = selector => document.querySelector(selector);
let roomId = location.hash.slice(1), key = null, current = null, selected = null;
let pollTimer, expiryTimer, clockTimer, entryTimer, deadline = 0, version = 0, polling = false;
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const stateNames = {waiting:'Waiting',collecting:'Collecting feed',available:'Feed available',empty:'No recent movie entries',blocked:'Blocked',unavailable:'Unavailable','not-requested':'Not requested'};
function message(text, error = false) { $('#night-status').hidden = !text; $('#night-status').textContent = text; $('#night-status').className = error ? 'status error' : 'status'; }
function stop(text = '') {
  version++; clearTimeout(entryTimer); clearTimeout(pollTimer); clearTimeout(expiryTimer); clearInterval(clockTimer);
  roomId = ''; key = null; current = null; selected = null; deadline = 0; polling = false;
  $('#room').hidden = true; $('#entry').hidden = false; $('#explore').hidden = true;
  for (const id of ['#members','#constellation','#candidates','#nominees','#film-detail','#outcome']) $(id).replaceChildren();
  for (const id of ['#night-username','#invite-link','#film-search']) $(id).value = '';
  $('#permission').checked = false; $('#enter-room').disabled = false;
  $('#entry-title').textContent = 'Start a room'; $('#enter-room').textContent = 'Create room';
  for (const id of ['#graph-count','#film-total','#shortlist-count','#vote-summary','#room-clock']) $(id).textContent = '';
  try { history.replaceState(null,'','/night'); } catch {}
  message(text);
}
function depart() {
  if (roomId && key) navigator.sendBeacon(`/api/night/${roomId}/leave`, new Blob([JSON.stringify({token:key})],{type:'application/json'}));
  stop();
}
async function api(action = '', body, method = 'POST') {
  const path = action === 'create' ? '/api/night' : `/api/night/${roomId}${action ? '/' + action : ''}`;
  const response = await fetch(path,{method,cache:'no-store',headers:{...(key?{Authorization:`Bearer ${key}`} : {}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Room request failed.'); error.status = response.status; throw error; }
  return data;
}
function armExpiry(ms) {
  if (!deadline) {
    deadline = performance.now() + ms;
    expiryTimer = setTimeout(()=>{depart();message('Room expired. All session data has been cleared.');},Math.max(0,ms));
    clockTimer = setInterval(()=>{
      const seconds=Math.max(0,Math.ceil((deadline-performance.now())/1000));
      $('#room-clock').textContent = `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} remaining. Leaving ends the room.`;
    },250);
  }
}
async function refresh() {
  if (!key || polling) return;
  const stamp = version; polling = true;
  try { const data = await api('',undefined,'GET'); if(stamp===version)render(data); }
  catch(error) { if(stamp===version){if(error.status===410||error.status===403)stop(error.message);else message('Connection interrupted. The room still expires on time.',true);} }
  finally { if(stamp===version){polling=false;if(key)pollTimer=setTimeout(refresh,1000);} }
}
function svg(tag, attrs, text) {
  const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [name,value]of Object.entries(attrs))el.setAttribute(name,String(value));
  if(text!==undefined)el.textContent=text;
  return el;
}
function constellation(data) {
  const graph=$('#constellation'); graph.replaceChildren();
  const members=data.members, positions=new Map();
  members.forEach((person,i)=>{const angle=-Math.PI/2+i*2*Math.PI/members.length;positions.set(person.id,{x:500+360*Math.cos(angle),y:310+235*Math.sin(angle)});});
  graph.append(svg('ellipse',{cx:500,cy:310,rx:360,ry:235,class:'orbit'}));
  const movies=[...data.movies].sort((a,b)=>b.loggedBy.length-a.loggedBy.length||a.title.localeCompare(b.title)).slice(0,60);
  movies.forEach((movie,i)=>{
    const angle=i*2.3999632297;const radius=Math.sqrt((i+.5)/Math.max(1,movies.length));
    const x=500+250*radius*Math.cos(angle),y=310+170*radius*Math.sin(angle);
    for(const entry of movie.loggedBy){const person=members.find(m=>m.id===entry.memberId),p=positions.get(entry.memberId);if(p)graph.append(svg('line',{x1:p.x,y1:p.y,x2:x,y2:y,class:`connection ${person.color}`}));}
    const group=svg('g',{class:`film-node${selected===movie.id?' selected':''}`,tabindex:0,role:'button','aria-label':`${movie.title}, in ${movie.loggedBy.length} recent feeds`,'data-film-id':movie.id});
    group.append(svg('title',{},movie.title),svg('circle',{cx:x,cy:y,r:6+movie.loggedBy.length*2}));
    const choose=()=>selectFilm(movie.id);
    group.addEventListener('click',choose);group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose();}});
    graph.append(group);
  });
  members.forEach(person=>{const p=positions.get(person.id);graph.append(svg('circle',{cx:p.x,cy:p.y,r:15,class:`friend-node ${person.color}`}),svg('text',{x:p.x,y:p.y+33,'text-anchor':'middle',class:'friend-name'},person.username.length>16?person.username.slice(0,15)+'…':person.username));});
  $('#graph-count').textContent=`${movies.length} of ${data.movies.length} films`;
  $('#graph-empty').hidden=data.movies.length!==0;
}
function candidates() {
  const list=$('#candidates'); list.replaceChildren(); if(!current)return;
  const search=$('#film-search').value.trim().toLowerCase();
  const films=current.movies.filter(f=>`${f.title} ${f.year||''}`.toLowerCase().includes(search)).sort((a,b)=>b.loggedBy.length-a.loggedBy.length||a.title.localeCompare(b.title));
  for(const film of films){const li=node('li');const button=node('button',undefined,'candidate');button.type='button';button.dataset.filmId=film.id;button.setAttribute('aria-pressed',String(film.id===selected));button.append(node('span',film.title),node('small',`${film.year||'Year unknown'} · ${film.loggedBy.length} feed${film.loggedBy.length===1?'':'s'}`));button.addEventListener('click',()=>selectFilm(film.id));li.append(button);list.append(li);}
  if(!films.length)list.append(node('li',search?'No matching films.':'No films in the collected movie feeds.','no-data'));
  $('#film-total').textContent=`${current.movies.length} films`;
}
function selectFilm(id) {
  selected=id;renderDetail();
  for(const el of document.querySelectorAll('[data-film-id]')) {
    const active=el.dataset.filmId===id;
    if(el.classList.contains('film-node'))el.classList.toggle('selected',active);
    el.setAttribute('aria-pressed',String(active));
  }
}
async function mutate(action,body) {
  const stamp=version;
  try {const data=await api(action,body);if(stamp===version)render(data);}
  catch(error){if(stamp===version){if(error.status===410)stop(error.message);else message(error.message,true);}}
}
function renderDetail() {
  const panel=$('#film-detail');panel.replaceChildren();const film=current?.movies.find(f=>f.id===selected);panel.hidden=!film;
  if(!film)return;
  panel.append(node('h4',film.title),node('p',film.year?String(film.year):'Year unavailable'));
  const list=node('ul');
  for(const person of current.members){const entry=film.loggedBy.find(e=>e.memberId===person.id);const info=entry?[entry.rating==null?'Unrated':`${entry.rating}/5`,entry.liked?'Liked':null,entry.rewatch?'Rewatch':null].filter(Boolean).join(', '):['blocked','unavailable','not-requested'].includes(person.feedState)?'Feed unavailable':'No entry in this recent feed';list.append(node('li',`@${person.username}: ${info}`));}
  panel.append(list);
  const nominated=current.nominations.some(n=>n.filmId===film.id);const button=node('button',nominated?'Shortlisted':'Add to shortlist');button.type='button';button.disabled=nominated;button.addEventListener('click',()=>mutate('nominate',{filmId:film.id}));panel.append(button);
}
function shortlist() {
  const list=$('#nominees');list.replaceChildren();
  for(const item of current.nominations){const film=current.movies.find(f=>f.id===item.filmId);const card=node('article',undefined,'nominee');card.append(node('h4',film.title),node('p',`${item.votes} vote${item.votes===1?'':'s'}`));const button=node('button',current.ownVote===film.id?'Your vote':`Vote for ${film.title}`);button.type='button';button.setAttribute('aria-pressed',String(current.ownVote===film.id));button.addEventListener('click',()=>mutate('vote',{filmId:film.id}));card.append(button);list.append(card);}
  if(!current.nominations.length)list.append(node('p','Select a film to nominate it.','no-data'));
  $('#shortlist-count').textContent=`${current.nominations.length} of 6`;
  $('#vote-summary').textContent=`${current.votesCast} of ${current.members.length} friends have voted. You can change your vote.`;
  $('#outcome').hidden=!current.outcome;
  $('#outcome').textContent=current.outcome?`${current.outcome.kind==='winner'?'Tonight’s pick':'Tied'}: ${current.outcome.filmIds.map(id=>current.movies.find(f=>f.id===id).title).join(', ')}`:'';
}
function render(data) {
  if(current && data.revision <= current.revision)return;
  current=data;roomId=data.id;
  $('#entry').hidden=true;$('#room').hidden=false;armExpiry(data.expiresInMs);
  $('#night-username').value='';$('#permission').checked=false;
  $('#invite-link').value=`${location.origin}/night#${roomId}`;
  const members=$('#members');members.replaceChildren();
  for(const person of data.members){const li=node('li',undefined,`member ${person.color}`);li.append(node('span',undefined,'swatch'),node('strong',`@${person.username}${person.id===data.selfId?' (you)':''}`),node('span',stateNames[person.feedState]));members.append(li);}
  const lobby=data.state==='lobby',host=data.selfId===data.hostId;
  $('#invite-panel').hidden=!lobby;$('#start-night').hidden=!lobby||!host;$('#start-night').disabled=data.members.length<2;
  $('#explore').hidden=!['ready','partial'].includes(data.state);
  if(lobby)message(host?'Share the room link. Collect feeds once 2–6 friends have joined.':'You joined. The host can collect the feeds.');
  else if(data.state==='collecting')message('Collecting recent feeds. Stay on this page.');
  else if(data.state==='partial')message('Some feeds are unavailable. Only verified entries are included; voting can continue.',true);
  else if(data.state==='failed')message('No feeds could be collected. The room has no films to vote on.',true);
  else message('');
  if(['ready','partial'].includes(data.state)){constellation(data);candidates();renderDetail();shortlist();}
}
$('#night-form').addEventListener('submit',async event=>{
  event.preventDefault();const username=$('#night-username').value.trim();
  if(!/^[a-zA-Z0-9_]{1,40}$/.test(username)){message('Enter a username using letters, numbers or underscores.',true);return;}
  clearTimeout(entryTimer);entryTimer=setTimeout(()=>{depart();message('Session cleared.');},120000);
  $('#enter-room').disabled=true;const stamp=version;
  try {const data=await api(roomId?'join':'create',{username,consent:$('#permission').checked});
    if(stamp!==version){navigator.sendBeacon(`/api/night/${data.room.id}/leave`,new Blob([JSON.stringify({token:data.token})],{type:'application/json'}));return;}
    clearTimeout(entryTimer);key=data.token;roomId=data.room.id;history.replaceState(null,'',`/night#${roomId}`);render(data.room);pollTimer=setTimeout(refresh,1000);
  }catch(error){if(stamp===version){if(error.status===410)stop(error.message);else message(error.message,true);}}
  finally{if(stamp===version)$('#enter-room').disabled=false;}
});
$('#start-night').addEventListener('click',()=>mutate('start',{}));
$('#film-search').addEventListener('input',candidates);
$('#leave-room').addEventListener('click',async()=>{const id=roomId,secret=key;depart();message('Room ended. All session data has been cleared.');try{await fetch(`/api/night/${id}/leave`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:'{}',cache:'no-store'});}catch{}});
$('#copy-invite').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#invite-link').value);message('Room link copied.');}catch{$('#invite-link').focus();$('#invite-link').select();message('Select and copy the room link.');}});
window.addEventListener('pagehide',depart);
window.addEventListener('pageshow',event=>{if(event.persisted)stop('Previous room cleared.');});
if(roomId){if(!/^[A-Za-z0-9_-]{32}$/.test(roomId)){stop('Invalid room link.');}else{$('#entry-title').textContent='Join a room';$('#enter-room').textContent='Join room';}}
