// Browser front end: wires the Z-machine to the transcript, art, map and inventory panels.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const SAVE_KEY = 'zork1-save';
  const DIR_CMD = { N: 'north', S: 'south', E: 'east', W: 'west', NE: 'northeast', NW: 'northwest',
    SE: 'southeast', SW: 'southwest', Up: 'up', Down: 'down', In: 'in', Out: 'out', Land: 'land' };

  const bytes = Uint8Array.from(atob(window.ZORK_STORY_B64), c => c.charCodeAt(0));
  let out = '';
  let visited = new Set();
  let dark = false;
  const history = [];
  let histPos = 0;

  const store = {
    get() { try { return localStorage.getItem(SAVE_KEY); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(SAVE_KEY, v); return true; } catch (e) { return false; } },
  };

  const z = new ZMachine(bytes, {
    print: s => { out += s; },
    save: snap => store.set(JSON.stringify({ snap, visited: [...visited] })),
    restore: () => {
      const raw = store.get();
      if (!raw) return null;
      try { const d = JSON.parse(raw); visited = new Set(d.visited); return d.snap; } catch (e) { return null; }
    },
    onRestart: () => { visited = new Set(); dark = false; },
    onQuit: () => {
      $('cmd').disabled = true;
      addLine('— The game has ended. —', 'sys');
      const b = document.createElement('button');
      b.textContent = 'Play again';
      b.onclick = () => { z.reset(); visited = new Set(); $('cmd').disabled = false; runAndRender(); };
      $('actions').replaceChildren(b);
    },
  });

  // Discover game-world structure from the story file itself (once the game has set HERE).
  let roomsParent = 0, roomCount = 0, roomNames = new Set(), player = 0;
  function discover() {
    roomsParent = z.parent(z.global(0));
    const rooms = z.children(roomsParent);
    roomCount = rooms.length;
    roomNames = new Set(rooms.map(r => z.objName(r)));
    for (let i = 1; i < 256 && !player; i++) if (z.objName(i) === 'cretin') player = i;
  }

  function addLine(text, cls) {
    const t = $('transcript');
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    t.appendChild(div);
    while (t.childNodes.length > 600) t.removeChild(t.firstChild);
  }

  function flush() {
    let text = out.replace(/\n>\s*$/, '\n').replace(/^>\s*$/, '');
    out = '';
    const here = z.global(0);
    if (/pitch black|too dark to see/i.test(text)) dark = true;
    else if (text.split('\n').some(l => l.trim() === z.objName(here))) dark = false;
    for (const line of text.replace(/\n+$/, '').split('\n')) {
      const s = line.trim();
      let cls = '';
      if (roomNames.has(s)) cls = 'room-title';
      else if (/eaten by a grue|you have died|\*\*\*\*/i.test(s)) cls = 'danger';
      else if (/^(taken|done|ok)\.?$|score has just gone up|^your score/i.test(s)) cls = 'good';
      addLine(line, cls);
    }
    const t = $('transcript');
    t.scrollTop = t.scrollHeight;
  }

  function render() {
    const s = z.statusInfo();
    const here = s.locationId;
    if (!dark) visited.add(here);
    $('status-location').textContent = s.location;
    $('status-score').textContent = s.score;
    $('status-moves').textContent = s.moves;

    const ctx = { id: here, name: s.location, exits: ZorkMap.exits(z, here), dark };
    $('scene-title').textContent = dark ? 'Darkness' : s.location;
    $('art').innerHTML = ZorkArt.render(ctx);

    const m = ZorkMap.render(z, here, visited);
    $('map').innerHTML = m.html;
    $('visited-count').textContent = `(${visited.size}/${roomCount} rooms)`;
    $('vertical').replaceChildren(...m.vertical.map(v => {
      const b = document.createElement('button');
      b.textContent = v;
      b.onclick = () => submit(DIR_CMD[v.split(':')[0]]);
      return b;
    }));

    const items = player ? z.children(player).map(o => z.objName(o)) : [];
    $('inventory').innerHTML = '';
    if (!items.length) $('inventory').innerHTML = '<li class="empty">empty-handed</li>';
    for (const name of items) {
      const li = document.createElement('li');
      li.textContent = name;
      $('inventory').appendChild(li);
    }

    const actions = $('actions');
    actions.replaceChildren();
    const btn = (label, cmd, cls) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = () => submit(cmd);
      actions.appendChild(b);
    };
    if (!z.halted) {
      for (const e of m.exits) btn(e, DIR_CMD[e], 'exit');
      btn('look', 'look'); btn('inventory', 'inventory'); btn('take all', 'take all');
    }
  }

  function runAndRender() {
    try { z.run(); } catch (e) { out += `\n[Interpreter error: ${e.message}]\n`; console.error(e); }
    flush();
    render();
  }

  function submit(cmd) {
    if (!cmd || z.halted || !z.waiting) return;
    addLine('> ' + cmd, 'cmd');
    history.push(cmd);
    histPos = history.length;
    try { z.input(cmd); } catch (e) { out += `\n[Interpreter error: ${e.message}]\n`; console.error(e); }
    flush();
    render();
    $('cmd').focus();
  }

  $('prompt').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('cmd').value.trim();
    $('cmd').value = '';
    submit(v);
  });
  $('cmd').addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && histPos > 0) { $('cmd').value = history[--histPos]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { histPos = Math.min(history.length, histPos + 1); $('cmd').value = history[histPos] || ''; e.preventDefault(); }
  });

  try { z.run(); } catch (e) { out += `\n[Interpreter error: ${e.message}]\n`; console.error(e); }
  discover();
  flush();
  render();
})();
