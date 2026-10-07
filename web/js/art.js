// Coloured ASCII art engine. Scenes are registered by room name (and by object
// id where several rooms share a name). Characters are coloured via a palette.
(function (root) {
  'use strict';

  const DEFAULT_PAL = {
    '~': 'c-blue', '≈': 'c-blue', '^': 'c-green', '"': 'c-green', '&': 'c-lime',
    '*': 'c-yellow', '$': 'c-gold', '#': 'c-grey', '%': 'c-brown', '!': 'c-red',
    '@': 'c-white', '.': 'c-dim', ':': 'c-dim', "'": 'c-dim',
  };

  const byName = Object.create(null);
  const byId = Object.create(null);
  const generators = Object.create(null);

  // add('Room Name', {art, pal, fg}) or add(17, {...}) for a specific room id.
  function add(key, scene) {
    scene.art = scene.art.replace(/^\n/, '').replace(/\s+$/, '');
    if (typeof key === 'number') byId[key] = scene; else byName[key] = scene;
  }
  // gen('Room Name', (ctx) => scene) builds art from live room data (e.g. its exits).
  function gen(name, fn) { generators[name] = fn; }

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function toHtml(scene) {
    const pal = Object.assign({}, DEFAULT_PAL, scene.pal || {});
    const fg = scene.fg || 'c-fg';
    let out = '', cur = null, buf = '';
    const flush = () => { if (buf) out += `<span class="${cur}">${esc(buf)}</span>`; buf = ''; };
    const chars = [...scene.art];
    const isLetter = c => /[A-Za-z]/.test(c || '');
    // Letters only take a palette colour in same-letter runs ("TTTT", "o"), so
    // words inside a scene ("you", "axe") keep the base colour.
    const inWord = i => {
      let a = i, b = i;
      while (isLetter(chars[a - 1])) a--;
      while (isLetter(chars[b + 1])) b++;
      for (let k = a; k <= b; k++) if (chars[k] !== chars[i]) return true;
      return false;
    };
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const plain = !scene.letters && isLetter(ch) && inWord(i);
      const cls = ch === '\n' || ch === ' ' ? cur : plain ? fg : (pal[ch] || fg);
      if (cls !== cur) { flush(); cur = cls; }
      buf += ch;
    }
    flush();
    return out;
  }

  // ctx: { id, name, exits: [{dir:{name}, dest}], dark }
  function sceneFor(ctx) {
    if (ctx.dark) return byName['@dark'];
    return byId[ctx.id] || (generators[ctx.name] && generators[ctx.name](ctx)) || byName[ctx.name] || byName['@unknown'];
  }

  const api = { add, gen, render: ctx => toHtml(sceneFor(ctx)), sceneFor, byName, byId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZorkArt = api;
})(this);
