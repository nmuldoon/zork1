// Minimal Z-machine version 3 interpreter — enough to run Zork I faithfully.
// Runs in the browser (window.ZMachine) and in Node (module.exports) for testing.
(function (root) {
  'use strict';

  const A0 = 'abcdefghijklmnopqrstuvwxyz';
  const A1 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const A2 = ' \n0123456789.,!?_#\'"/\\-:()'; // index 0 = escape placeholder

  class ZMachine {
    // io: { print(text), statusLine(info), onQuit() }
    constructor(storyBytes, io) {
      this.story = new Uint8Array(storyBytes);
      this.io = io;
      this.reset();
    }

    reset() {
      this.mem = new Uint8Array(this.story);
      const m = this.mem;
      if (m[0] !== 3) throw new Error('Only version 3 story files are supported (got v' + m[0] + ')');
      this.pc = this.word(0x06);
      this.dict = this.word(0x08);
      this.objTable = this.word(0x0A);
      this.globals = this.word(0x0C);
      this.staticBase = this.word(0x0E);
      this.abbrev = this.word(0x18);
      // Interpreter capabilities: status line available, no split screen, no variable font.
      m[0x01] &= ~0x70;
      m[0x01] &= ~0x10;
      m[0x20] = 25; m[0x21] = 80;
      this.stack = [];
      this.frames = [];
      this.waiting = null;   // pending sread {text, parse}
      this.halted = false;
      this.streams = { screen: true, mem: [] };
      this.seed = 0;
      this.loadDictionary();
    }

    // ---------- memory ----------
    byte(a) { return this.mem[a]; }
    word(a) { return (this.mem[a] << 8) | this.mem[a + 1]; }
    setByte(a, v) { this.mem[a] = v & 0xFF; }
    setWord(a, v) { this.mem[a] = (v >> 8) & 0xFF; this.mem[a + 1] = v & 0xFF; }
    fetchByte() { return this.mem[this.pc++]; }
    fetchWord() { const w = this.word(this.pc); this.pc += 2; return w; }
    static s16(v) { return v & 0x8000 ? v - 0x10000 : v; }

    // ---------- variables ----------
    readVar(n, indirect) {
      if (n === 0) {
        if (!this.stack.length) throw new Error('Stack underflow');
        return indirect ? this.stack[this.stack.length - 1] : this.stack.pop();
      }
      if (n < 16) return this.frames[this.frames.length - 1].locals[n - 1];
      return this.word(this.globals + 2 * (n - 16));
    }
    writeVar(n, v, indirect) {
      v &= 0xFFFF;
      if (n === 0) {
        if (indirect) this.stack[this.stack.length - 1] = v; else this.stack.push(v);
      } else if (n < 16) this.frames[this.frames.length - 1].locals[n - 1] = v;
      else this.setWord(this.globals + 2 * (n - 16), v);
    }
    global(n) { return this.word(this.globals + 2 * n); }

    // ---------- text ----------
    decodeText(addr, noAbbrev) {
      let out = '';
      let alphabet = 0, abbrevBank = -1, escape = -1, escHi = 0;
      for (;;) {
        const w = this.word(addr); addr += 2;
        const zc = [(w >> 10) & 31, (w >> 5) & 31, w & 31];
        for (const c of zc) {
          if (abbrevBank >= 0) {
            const a = this.word(this.abbrev + 2 * (32 * abbrevBank + c)) * 2;
            out += this.decodeText(a, true).text;
            abbrevBank = -1;
          } else if (escape === 0) { escHi = c; escape = 1; }
          else if (escape === 1) { out += this.zsciiToChar((escHi << 5) | c); escape = -1; }
          else if (c === 0) { out += ' '; alphabet = 0; }
          else if (c >= 1 && c <= 3) { if (!noAbbrev) abbrevBank = c - 1; }
          else if (c === 4) alphabet = 1;
          else if (c === 5) alphabet = 2;
          else {
            if (alphabet === 2 && c === 6) escape = 0;
            else out += (alphabet === 0 ? A0 : alphabet === 1 ? A1 : A2)[c - 6];
            alphabet = 0;
          }
        }
        if (w & 0x8000) break;
      }
      return { text: out, end: addr };
    }
    zsciiToChar(z) {
      if (z === 13) return '\n';
      if (z >= 32 && z <= 126) return String.fromCharCode(z);
      return '';
    }
    encodeWord(word) {
      const zc = [];
      for (const ch of word) {
        let i;
        if ((i = A0.indexOf(ch)) >= 0) zc.push(i + 6);
        else if ((i = A2.indexOf(ch)) > 1) zc.push(5, i + 6);
        else { const z = ch.charCodeAt(0); zc.push(5, 6, (z >> 5) & 31, z & 31); }
        if (zc.length >= 6) break;
      }
      while (zc.length < 6) zc.push(5);
      const w1 = (zc[0] << 10) | (zc[1] << 5) | zc[2];
      const w2 = (zc[3] << 10) | (zc[4] << 5) | zc[5] | 0x8000;
      return [w1, w2];
    }

    // ---------- dictionary ----------
    loadDictionary() {
      let a = this.dict;
      const n = this.byte(a++);
      this.separators = [];
      for (let i = 0; i < n; i++) this.separators.push(String.fromCharCode(this.byte(a++)));
      this.entryLen = this.byte(a++);
      this.entryCount = ZMachine.s16(this.word(a)); a += 2;
      this.entries = a;
      this.dictMap = new Map();
      for (let i = 0; i < Math.abs(this.entryCount); i++) {
        const e = a + i * this.entryLen;
        this.dictMap.set(this.word(e) * 65536 + this.word(e + 2), e);
      }
    }
    lookup(word) {
      const [w1, w2] = this.encodeWord(word);
      return this.dictMap.get(w1 * 65536 + w2) || 0;
    }
    tokenise(textAddr, parseAddr) {
      let s = '';
      for (let i = 1; this.byte(textAddr + i) !== 0; i++) s += String.fromCharCode(this.byte(textAddr + i));
      const words = [];
      let cur = '', start = 0;
      for (let i = 0; i <= s.length; i++) {
        const ch = s[i];
        if (ch === undefined || ch === ' ' || this.separators.includes(ch)) {
          if (cur) words.push({ w: cur, pos: start });
          cur = '';
          if (ch !== undefined && ch !== ' ') words.push({ w: ch, pos: i });
        } else {
          if (!cur) start = i;
          cur += ch;
        }
      }
      const max = this.byte(parseAddr);
      const count = Math.min(max, words.length);
      this.setByte(parseAddr + 1, count);
      for (let i = 0; i < count; i++) {
        const b = parseAddr + 2 + 4 * i;
        this.setWord(b, this.lookup(words[i].w));
        this.setByte(b + 2, words[i].w.length);
        this.setByte(b + 3, words[i].pos + 1);
      }
    }

    // ---------- objects ----------
    objAddr(o) { return this.objTable + 62 + (o - 1) * 9; }
    parent(o) { return this.byte(this.objAddr(o) + 4); }
    sibling(o) { return this.byte(this.objAddr(o) + 5); }
    child(o) { return this.byte(this.objAddr(o) + 6); }
    setParent(o, v) { this.setByte(this.objAddr(o) + 4, v); }
    setSibling(o, v) { this.setByte(this.objAddr(o) + 5, v); }
    setChild(o, v) { this.setByte(this.objAddr(o) + 6, v); }
    propTable(o) { return this.word(this.objAddr(o) + 7); }
    objName(o) {
      if (!o) return '';
      const p = this.propTable(o);
      return this.byte(p) ? this.decodeText(p + 1).text : '';
    }
    testAttr(o, a) { return !!(this.byte(this.objAddr(o) + (a >> 3)) & (0x80 >> (a & 7))); }
    setAttr(o, a, on) {
      const addr = this.objAddr(o) + (a >> 3), bit = 0x80 >> (a & 7);
      this.setByte(addr, on ? this.byte(addr) | bit : this.byte(addr) & ~bit);
    }
    removeObj(o) {
      const p = this.parent(o);
      if (!p) return;
      if (this.child(p) === o) this.setChild(p, this.sibling(o));
      else {
        let c = this.child(p);
        while (c && this.sibling(c) !== o) c = this.sibling(c);
        if (c) this.setSibling(c, this.sibling(o));
      }
      this.setParent(o, 0); this.setSibling(o, 0);
    }
    insertObj(o, d) {
      this.removeObj(o);
      this.setSibling(o, this.child(d));
      this.setChild(d, o);
      this.setParent(o, d);
    }
    firstProp(o) { const p = this.propTable(o); return p + 1 + 2 * this.byte(p); }
    // Returns {addr (of data), num, size} for each property of o.
    props(o) {
      const out = [];
      let a = this.firstProp(o);
      for (let b = this.byte(a); b; b = this.byte(a)) {
        const size = (b >> 5) + 1;
        out.push({ num: b & 31, addr: a + 1, size });
        a += 1 + size;
      }
      return out;
    }
    findProp(o, n) { return this.props(o).find(p => p.num === n); }
    getProp(o, n) {
      const p = this.findProp(o, n);
      if (!p) return this.word(this.objTable + 2 * (n - 1));
      return p.size === 1 ? this.byte(p.addr) : this.word(p.addr);
    }
    children(o) {
      const out = [];
      for (let c = this.child(o); c; c = this.sibling(c)) out.push(c);
      return out;
    }

    // ---------- output ----------
    print(s) {
      if (!s) return;
      if (this.streams.mem.length) {
        const t = this.streams.mem[this.streams.mem.length - 1];
        for (const ch of s) { this.setByte(t.addr + 2 + t.len, ch === '\n' ? 13 : ch.charCodeAt(0)); t.len++; }
        return;
      }
      if (this.streams.screen) this.io.print(s);
    }
    statusInfo() {
      return {
        location: this.objName(this.global(0)),
        locationId: this.global(0),
        score: ZMachine.s16(this.global(1)),
        moves: this.global(2),
      };
    }

    // ---------- control ----------
    call(addr, args, store) {
      if (addr === 0) { if (store !== undefined) this.writeVar(store, 0); return; }
      let a = addr * 2;
      const n = this.byte(a++);
      const locals = [];
      for (let i = 0; i < n; i++) { locals.push(this.word(a)); a += 2; }
      for (let i = 0; i < Math.min(n, args.length); i++) locals[i] = args[i];
      this.frames.push({ ret: this.pc, store, locals, sp: this.stack.length });
      this.pc = a;
    }
    ret(v) {
      const f = this.frames.pop();
      this.stack.length = f.sp;
      this.pc = f.ret;
      if (f.store !== undefined) this.writeVar(f.store, v);
    }
    branch(cond) {
      const b = this.fetchByte();
      let off;
      if (b & 0x40) off = b & 0x3F;
      else { off = ((b & 0x3F) << 8) | this.fetchByte(); if (off & 0x2000) off -= 0x4000; }
      if (!!(b & 0x80) !== !!cond) return;
      if (off === 0 || off === 1) this.ret(off);
      else this.pc += off - 2;
    }
    random(range) {
      range = ZMachine.s16(range);
      if (range > 0) return 1 + Math.floor(Math.random() * range);
      return 0;
    }

    // ---------- save / restore (snapshot to an opaque object) ----------
    snapshot() {
      return {
        mem: Array.from(this.mem.subarray(0, this.staticBase)),
        stack: this.stack.slice(),
        frames: this.frames.map(f => ({ ...f, locals: f.locals.slice() })),
        pc: this.pc,
      };
    }
    restoreSnapshot(s) {
      this.mem.set(s.mem, 0);
      this.stack = s.stack.slice();
      this.frames = s.frames.map(f => ({ ...f, locals: f.locals.slice() }));
      this.pc = s.pc;
    }

    // ---------- input ----------
    // Supplies a line of player input to a pending sread and continues running.
    input(line) {
      if (!this.waiting) return;
      const { text, parse } = this.waiting;
      this.waiting = null;
      const max = this.byte(text) - 1;
      const s = line.toLowerCase().slice(0, max);
      for (let i = 0; i < s.length; i++) this.setByte(text + 1 + i, s.charCodeAt(i));
      this.setByte(text + 1 + s.length, 0);
      this.tokenise(text, parse);
      this.run();
    }

    // ---------- main loop ----------
    run() {
      while (!this.waiting && !this.halted) this.step();
    }

    step() {
      const op = this.fetchByte();
      let form, num, operands = [];
      const readOperand = t => t === 0 ? this.fetchWord() : t === 1 ? this.fetchByte() : this.readVar(this.fetchByte());
      if ((op & 0xC0) === 0xC0) {
        form = op & 0x20 ? 'VAR' : '2OP';
        num = op & 0x1F;
        const types = this.fetchByte();
        for (let s = 6; s >= 0; s -= 2) {
          const t = (types >> s) & 3;
          if (t === 3) break;
          operands.push(readOperand(t));
        }
      } else if ((op & 0xC0) === 0x80) {
        const t = (op >> 4) & 3;
        num = op & 0x0F;
        if (t === 3) form = '0OP';
        else { form = '1OP'; operands.push(readOperand(t)); }
      } else {
        form = '2OP';
        num = op & 0x1F;
        operands.push(readOperand(op & 0x40 ? 2 : 1));
        operands.push(readOperand(op & 0x20 ? 2 : 1));
      }
      this.exec(form, num, operands, op);
    }

    exec(form, num, o, op) {
      const S = ZMachine.s16;
      const store = v => this.writeVar(this.fetchByte(), v);
      const [a, b] = o;
      if (form === '2OP') {
        switch (num) {
          case 1: return this.branch(o.slice(1).some(x => x === a));
          case 2: return this.branch(S(a) < S(b));
          case 3: return this.branch(S(a) > S(b));
          case 4: { const v = S(this.readVar(a, true)) - 1; this.writeVar(a, v, true); return this.branch(v < S(b)); }
          case 5: { const v = S(this.readVar(a, true)) + 1; this.writeVar(a, v, true); return this.branch(v > S(b)); }
          case 6: return this.branch(this.parent(a) === b);
          case 7: return this.branch((a & b) === b);
          case 8: return store(a | b);
          case 9: return store(a & b);
          case 10: return this.branch(this.testAttr(a, b));
          case 11: return this.setAttr(a, b, true);
          case 12: return this.setAttr(a, b, false);
          case 13: return this.writeVar(a, b, true);
          case 14: return this.insertObj(a, b);
          case 15: return store(this.word((a + 2 * S(b)) & 0xFFFF));
          case 16: return store(this.byte((a + S(b)) & 0xFFFF));
          case 17: return store(this.getProp(a, b));
          case 18: { const p = this.findProp(a, b); return store(p ? p.addr : 0); }
          case 19: {
            const ps = this.props(a);
            if (b === 0) return store(ps.length ? ps[0].num : 0);
            const i = ps.findIndex(p => p.num === b);
            return store(i >= 0 && i + 1 < ps.length ? ps[i + 1].num : 0);
          }
          case 20: return store(S(a) + S(b));
          case 21: return store(S(a) - S(b));
          case 22: return store(S(a) * S(b));
          case 23: if (!S(b)) throw new Error('Division by zero'); return store(Math.trunc(S(a) / S(b)));
          case 24: if (!S(b)) throw new Error('Division by zero'); return store(S(a) % S(b));
        }
      } else if (form === '1OP') {
        switch (num) {
          case 0: return this.branch(a === 0);
          case 1: { const v = a ? this.sibling(a) : 0; store(v); return this.branch(v !== 0); }
          case 2: { const v = a ? this.child(a) : 0; store(v); return this.branch(v !== 0); }
          case 3: return store(a ? this.parent(a) : 0);
          case 4: return store(a ? (this.byte(a - 1) >> 5) + 1 : 0);
          case 5: return this.writeVar(a, S(this.readVar(a, true)) + 1, true);
          case 6: return this.writeVar(a, S(this.readVar(a, true)) - 1, true);
          case 7: return this.print(this.decodeText(a).text);
          case 9: return this.removeObj(a);
          case 10: return this.print(this.objName(a));
          case 11: return this.ret(a);
          case 12: this.pc += S(a) - 2; return;
          case 13: return this.print(this.decodeText(a * 2).text);
          case 14: return store(this.readVar(a, true));
          case 15: return store(~a);
        }
      } else if (form === '0OP') {
        switch (num) {
          case 0: return this.ret(1);
          case 1: return this.ret(0);
          case 2: { const t = this.decodeText(this.pc); this.pc = t.end; return this.print(t.text); }
          case 3: { const t = this.decodeText(this.pc); this.pc = t.end; this.print(t.text + '\n'); return this.ret(1); }
          case 4: return;
          case 5: { // save
            const ok = this.io.save ? this.io.save({ ...this.snapshot(), pc: this.pc }) : false;
            return this.branch(ok);
          }
          case 6: { // restore
            const s = this.io.restore ? this.io.restore() : null;
            if (!s) return this.branch(false);
            this.restoreSnapshot(s);
            return this.branch(true);
          }
          case 7: { const f2 = this.word(0x10); this.reset(); this.setWord(0x10, f2); if (this.io.onRestart) this.io.onRestart(); return; }
          case 8: return this.ret(this.stack.pop());
          case 9: this.stack.pop(); return;
          case 10: this.halted = true; if (this.io.onQuit) this.io.onQuit(); return;
          case 11: return this.print('\n');
          case 12: if (this.io.statusLine) this.io.statusLine(this.statusInfo()); return;
          case 13: return this.branch(true);
        }
      } else {
        switch (num) {
          case 0: { const st = this.fetchByte(); return this.call(a, o.slice(1), st); }
          case 1: return this.setWord((a + 2 * S(b)) & 0xFFFF, o[2]);
          case 2: return this.setByte((a + S(b)) & 0xFFFF, o[2]);
          case 3: {
            const p = this.findProp(a, b);
            if (!p) throw new Error('put_prop: missing property ' + b + ' on object ' + a);
            if (p.size === 1) this.setByte(p.addr, o[2]); else this.setWord(p.addr, o[2]);
            return;
          }
          case 4: // sread
            if (this.io.statusLine) this.io.statusLine(this.statusInfo());
            this.waiting = { text: a, parse: b };
            if (this.io.onInputRequest) this.io.onInputRequest();
            return;
          case 5: return this.print(this.zsciiToChar(a));
          case 6: return this.print(String(S(a)));
          case 7: return store(this.random(a));
          case 8: this.stack.push(a); return;
          case 9: return this.writeVar(a, this.stack.pop(), true);
          case 10: case 11: case 21: return; // split_window, set_window, sound_effect
          case 19: {
            const n = S(a);
            if (n === 1) this.streams.screen = true;
            else if (n === -1) this.streams.screen = false;
            else if (n === 3) this.streams.mem.push({ addr: b, len: 0 });
            else if (n === -3) { const t = this.streams.mem.pop(); if (t) this.setWord(t.addr, t.len); }
            return;
          }
          case 20: return;
        }
      }
      throw new Error(`Unknown opcode ${form}:${num} (0x${op.toString(16)}) at ${this.pc.toString(16)}`);
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = ZMachine;
  else root.ZMachine = ZMachine;
})(this);
