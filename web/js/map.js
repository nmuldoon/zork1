// Auto-drawn ASCII map. Exits are read straight from each room's direction
// properties in the story file, so the map reflects the real game world.
(function (root) {
  'use strict';

  // Property numbers assigned by <DIRECTIONS NORTH EAST WEST SOUTH NE NW SE SW UP DOWN IN OUT LAND>.
  const DIRS = {
    31: { name: 'N', dx: 0, dy: -1 }, 30: { name: 'E', dx: 1, dy: 0 },
    29: { name: 'W', dx: -1, dy: 0 }, 28: { name: 'S', dx: 0, dy: 1 },
    27: { name: 'NE', dx: 1, dy: -1 }, 26: { name: 'NW', dx: -1, dy: -1 },
    25: { name: 'SE', dx: 1, dy: 1 }, 24: { name: 'SW', dx: -1, dy: 1 },
    23: { name: 'Up' }, 22: { name: 'Down' }, 21: { name: 'In' }, 20: { name: 'Out' },
    19: { name: 'Land' },
  };
  // Exit property sizes: 1 UEXIT, 2 NEXIT (blocked, message only), 3 FEXIT (scripted),
  // 4 CEXIT (conditional), 5 DEXIT (door). Byte 0 is the destination for 1/4/5.
  function exits(z, room) {
    const out = [];
    for (const p of z.props(room)) {
      const d = DIRS[p.num];
      if (!d || p.size === 2) continue;
      const dest = p.size === 3 ? 0 : z.byte(p.addr);
      out.push({ dir: d, num: p.num, dest, conditional: p.size >= 3 });
    }
    return out;
  }

  const RADIUS = 2, CELL = 14, LABEL = 12;
  const STOP = new Set(['of', 'the', 'to', 'a']);

  const ABBR = { North: 'N.', South: 'S.', East: 'E.', West: 'W.', Entrance: 'Ent.', Reservoir: 'Res.',
    Maintenance: 'Maint.', Passage: 'Pass.', 'North-South': 'N/S', 'East-West': 'E/W' };
  function label(name) {
    let s = name.split(' ').filter(w => !STOP.has(w.toLowerCase())).join(' ');
    if (s.length > LABEL - 2) s = s.split(' ').map(w => ABBR[w] || w).join(' ');
    if (s.length > LABEL - 2) s = s.replace(/ Room$/, ' Rm');
    return s.slice(0, LABEL - 2);
  }

  // Renders HTML for the map centred on `here`. `visited` is a Set of room ids.
  function render(z, here, visited) {
    const size = RADIUS * 2 + 1;
    const pos = new Map([[here, [RADIUS, RADIUS]]]);
    const taken = new Map([[RADIUS + ',' + RADIUS, here]]);
    const queue = [here];
    // Breadth-first placement: only follow exits out of rooms the player has seen.
    while (queue.length) {
      const r = queue.shift();
      if (r !== here && !visited.has(r)) continue;
      const [x, y] = pos.get(r);
      for (const e of exits(z, r)) {
        if (!e.dest || e.dir.dx === undefined || pos.has(e.dest)) continue;
        const nx = x + e.dir.dx, ny = y + e.dir.dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size || taken.has(nx + ',' + ny)) continue;
        pos.set(e.dest, [nx, ny]); taken.set(nx + ',' + ny, e.dest);
        queue.push(e.dest);
      }
    }

    const W = size * CELL, H = size * 2 - 1;
    const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: ' ', cls: '' })));
    const put = (x, y, s, cls) => {
      for (let i = 0; i < s.length; i++) if (grid[y] && grid[y][x + i]) grid[y][x + i] = { ch: s[i], cls };
    };

    for (const [room, [x, y]] of pos) {
      if (!visited.has(room) && room !== here) continue;
      for (const e of exits(z, room)) {
        if (!e.dest || !pos.has(e.dest) || e.dir.dx === undefined) continue;
        const [tx, ty] = pos.get(e.dest);
        if (tx - x !== e.dir.dx || ty - y !== e.dir.dy) continue;
        const cls = e.conditional ? 'm-cond' : 'm-path';
        // Normalise so we always draw from the left/upper room.
        let [ax, ay, dx, dy] = [x, y, e.dir.dx, e.dir.dy];
        if (dx < 0 || (dx === 0 && dy < 0)) { ax = tx; ay = ty; dx = -dx; dy = -dy; }
        const cx = ax * CELL, ly = ay * 2;
        const cell = (gx, gy) => (grid[gy] && grid[gy][gx]) ? grid[gy][gx].ch : ' ';
        if (dy === 0) put(cx + LABEL, ly, '──', cls);
        else if (dx === 0) put(cx + LABEL / 2 - 1, ly + 1, '│', cls);
        else if (dy === 1) put(cx + LABEL + 1, ly + 1, cell(cx + LABEL + 1, ly + 1) === '╱' ? '╳' : '╲', cls);
        else put(cx + LABEL + 1, ly - 1, cell(cx + LABEL + 1, ly - 1) === '╲' ? '╳' : '╱', cls);
      }
    }
    for (const [room, [x, y]] of pos) {
      const known = visited.has(room) || room === here;
      const name = known ? label(z.objName(room)) : '?';
      const pad = LABEL - 2 - name.length;
      const text = '[' + ' '.repeat(Math.floor(pad / 2)) + name + ' '.repeat(Math.ceil(pad / 2)) + ']';
      put(x * CELL, y * 2, text, room === here ? 'm-here' : known ? 'm-room' : 'm-unknown');
    }

    // Trim empty rows/columns so the map stays compact.
    let rows = grid.map(r => r);
    while (rows.length && rows[0].every(c => c.ch === ' ')) rows.shift();
    while (rows.length && rows[rows.length - 1].every(c => c.ch === ' ')) rows.pop();
    let left = W, right = 0;
    for (const r of rows) r.forEach((c, i) => { if (c.ch !== ' ') { left = Math.min(left, i); right = Math.max(right, i); } });
    rows = rows.map(r => r.slice(left, right + 1));

    const html = rows.map(r => {
      let out = '', cur = null, buf = '';
      for (const c of r) {
        if (c.cls !== cur) { if (buf) out += cur ? `<span class="${cur}">${esc(buf)}</span>` : esc(buf); buf = ''; cur = c.cls; }
        buf += c.ch;
      }
      if (buf) out += cur ? `<span class="${cur}">${esc(buf)}</span>` : esc(buf);
      return out;
    }).join('\n');

    const vertical = exits(z, here).filter(e => e.dir.dx === undefined)
      .map(e => `${e.dir.name}: ${e.dest ? (visited.has(e.dest) ? z.objName(e.dest) : '?') : '?'}`);
    const all = exits(z, here).map(e => e.dir.name);
    return { html, exits: all, vertical };
  }

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  const api = { render, exits, DIRS, label };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZorkMap = api;
})(this);
