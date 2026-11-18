/* Minimal WebSocket server (RFC 6455) with no dependencies.
 * Text messages only. Handles the handshake, masking, fragmentation, ping/pong and close. */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WS extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket; this.max = maxPayload; this.buf = Buffer.alloc(0);
    this.frag = null; this.fragLen = 0; this.closed = false; this.alive = true;
    this.msgCount = 0; this.msgWin = Date.now();
    socket.on('data', d => { if (!this.closed) this._feed(d); });
    socket.on('error', () => {});
    socket.on('close', () => { this.closed = true; this.emit('close'); });
  }
  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed && this._parse()) {}
  }
  _fail(code) { this.close(code); return false; }
  _parse() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (!masked) return this._fail(1002);
    if (len === 126) { if (b.length < 4) return false; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return false;
      if (b.readUInt32BE(2) !== 0) return this._fail(1009);
      len = b.readUInt32BE(6); off = 10;
    }
    if (len > this.max) return this._fail(1009);
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4), p = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) p[i] = b[off + 4 + i] ^ mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    if (op & 0x8) { /* control frame */
      if (!fin || len > 125) return this._fail(1002);
      if (op === 0x8) { this.close(1000); return false; }
      if (op === 0x9) this._frame(0xA, p);
      if (op === 0xA) this.alive = true;
      return true;
    }
    if (op === 0x0) { /* continuation */
      if (!this.frag) return this._fail(1002);
      this.fragLen += len;
      if (this.fragLen > this.max) return this._fail(1009);
      this.frag.push(p);
      if (fin) { const m = Buffer.concat(this.frag); this.frag = null; this.fragLen = 0; this._msg(m); }
      return true;
    }
    if (op === 0x1 || op === 0x2) {
      if (this.frag) return this._fail(1002);
      if (fin) this._msg(p); else { this.frag = [p]; this.fragLen = len; }
      return true;
    }
    return this._fail(1002);
  }
  _msg(buf) {
    this.alive = true;
    const now = Date.now();
    if (now - this.msgWin > 1000) { this.msgWin = now; this.msgCount = 0; }
    if (++this.msgCount > 150) { this.close(1008); return; } /* more than 150 messages a second: abuse */
    this.emit('message', buf.toString('utf8'));
  }
  _frame(op, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const n = payload.length;
    let h;
    if (n < 126) h = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
    this.socket.write(Buffer.concat([h, payload]));
    return true;
  }
  /* Returns false if the message was dropped (closed, or the client is too slow to keep up). */
  send(str, droppable) {
    if (this.closed) return false;
    if (droppable && this.socket.writableLength > 256 * 1024) return false;
    return this._frame(0x1, Buffer.from(str, 'utf8'));
  }
  ping() { this.alive = false; this._frame(0x9, Buffer.alloc(0)); }
  close(code) {
    if (this.closed) return;
    this.closed = true;
    try {
      const c = Buffer.alloc(2); c.writeUInt16BE(code || 1000, 0);
      const h = Buffer.from([0x88, 2]);
      this.socket.write(Buffer.concat([h, c]));
      this.socket.end();
    } catch (e) {}
    setTimeout(() => { try { this.socket.destroy(); } catch (e) {} }, 1000).unref();
    this.emit('close');
  }
  terminate() { this.closed = true; try { this.socket.destroy(); } catch (e) {} this.emit('close'); }
}

/* Call from the http server's 'upgrade' event. */
function accept(req, socket, head, onConn, opts) {
  opts = opts || {};
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
  }
  if (opts.origin && opts.origin !== '*' && req.headers.origin && req.headers.origin !== opts.origin) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  const ws = new WS(socket, opts.maxPayload || 16384);
  onConn(ws);
  if (head && head.length) ws._feed(head);
}

module.exports = { accept, WS };
