// Runs ScrcpySession against a fake scrcpy-server speaking the v5 wire protocol over TCP.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { ScrcpySession, TOUCH_DOWN, KEYCODES } from '../src/scrcpy.js';

const SPS_PPS = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80]);
const IDR = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00]);
const P_FRAME = Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x22]);

function mediaPacket(flags, payload) {
  const h = Buffer.alloc(12);
  h.writeBigUInt64BE(flags, 0);
  h.writeUInt32BE(payload.length, 8);
  return Buffer.concat([h, payload]);
}

function sessionPacket(width, height) {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(0x80000000, 0);
  b.writeUInt32BE(width, 4);
  b.writeUInt32BE(height, 8);
  return b;
}

/** Fake device: `adb forward` starts a TCP server that behaves like scrcpy-server. */
function fakeDevice() {
  const control = [];
  let server;
  const device = {
    async exec(args) {
      if (args[0] === 'forward' && args[1] !== '--remove') {
        const port = Number(args[1].split(':')[1]);
        let sockets = 0;
        server = net.createServer((socket) => {
          sockets++;
          if (sockets === 1) {
            // video socket: dummy byte, then (after control connects) meta + stream
            socket.write(Buffer.from([0]));
            device.video = socket;
          } else {
            socket.on('data', (d) => control.push(d));
            const name = Buffer.alloc(64);
            name.write('Pixel 7');
            const codec = Buffer.alloc(4);
            codec.writeUInt32BE(0x68323634);
            // split writes to exercise partial-packet buffering
            const stream = Buffer.concat([
              name, codec, sessionPacket(720, 1600),
              mediaPacket(1n << 62n, SPS_PPS),
              mediaPacket((1n << 61n) | 1000n, IDR),
              mediaPacket(2000n, P_FRAME),
            ]);
            device.video.write(stream.subarray(0, 70));
            setTimeout(() => device.video.write(stream.subarray(70)), 20);
          }
        });
        await new Promise((r) => server.listen(port, '127.0.0.1', r));
      }
      return '';
    },
    spawn() {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.exitCode = null;
      proc.kill = () => {};
      return proc;
    },
    close: () => server?.close(),
    control,
  };
  return device;
}

test('handshakes, demuxes frames and encodes control messages', async () => {
  const device = fakeDevice();
  const session = new ScrcpySession({
    device,
    serverJar: '/dev/null',
    version: '5.0.1',
    video: { maxSize: 1600, bitRate: 8_000_000, maxFps: 60 },
  });
  const frames = [];
  const sizes = [];
  session.on('frame', (f) => frames.push(f));
  session.on('size', (s) => sizes.push(s));

  await session.start();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(session.deviceName, 'Pixel 7');
  assert.deepEqual(sizes, [{ width: 720, height: 1600 }]);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].key, true);
  assert.deepEqual(frames[0].data, Buffer.concat([SPS_PPS, IDR]), 'config is merged into the key frame');
  assert.equal(frames[1].key, false);
  assert.deepEqual(frames[1].data, P_FRAME);
  assert.equal(session.catchUpFrames().length, 2);

  session.touch(TOUCH_DOWN, 3, 100, 200, 720, 1600);
  session.pressKey(KEYCODES.home);
  session.text('hi');
  await new Promise((r) => setTimeout(r, 50));

  const sent = Buffer.concat(device.control);
  const touch = sent.subarray(0, 32);
  assert.equal(touch[0], 2);
  assert.equal(touch[1], TOUCH_DOWN);
  assert.equal(touch.readBigUInt64BE(2), 3n);
  assert.equal(touch.readInt32BE(10), 100);
  assert.equal(touch.readInt32BE(14), 200);
  assert.equal(touch.readUInt16BE(18), 720);
  assert.equal(touch.readUInt16BE(20), 1600);
  assert.equal(touch.readUInt16BE(22), 0xffff);

  const keyDown = sent.subarray(32, 46);
  assert.deepEqual([keyDown[0], keyDown[1], keyDown.readUInt32BE(2)], [0, 0, 3]);
  const keyUp = sent.subarray(46, 60);
  assert.deepEqual([keyUp[0], keyUp[1]], [0, 1]);

  const text = sent.subarray(60);
  assert.equal(text[0], 1);
  assert.equal(text.readUInt32BE(1), 2);
  assert.equal(text.subarray(5).toString(), 'hi');

  session.stop();
  device.close();
});
