import { AudioEngine, StaleDecodeError } from '../src/audio/AudioEngine';

/**
 * 播放源归属回归测试（AudioEngine + 极简 Web Audio 假实现）：
 * - 试听处理后结果期间导入新音频：新文件解码成功后，主播放 / 章节预览
 *   必须播放新文件的原始缓冲，旧的处理后缓冲不得残留为播放源；
 * - 被取代的旧解码完成时不得夺回播放源（StaleDecodeError）；
 * - 解码失败（坏文件）不改动当前播放源；
 * - 主播放从处理后试听切回原声时按 getTime() 保留当前播放位置；
 * - 共用定位链路（波形空白点击 / 章节跳转）按操作前的播放状态处理：
 *   先读 playing 再拆旧音源，播放中定位从目标秒数继续播放原声，
 *   暂停时定位不启动新音源。
 */

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`ok ${msg}`);
  else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function same(actual: unknown, expected: unknown, msg: string) {
  ok(Object.is(actual, expected), `${msg}（期望 ${nameOf(expected)}，实际 ${nameOf(actual)}）`);
}
function nameOf(v: unknown): string {
  return (v as { name?: string })?.name ?? String(v);
}
function approx(actual: number, expected: number, eps: number, msg: string) {
  if (Math.abs(actual - expected) <= eps) console.log(`ok ${msg}`);
  else {
    failures++;
    console.error(`FAIL ${msg}: expected ≈${expected}, got ${actual}`);
  }
}

// ---- 极简 Web Audio 假实现：只覆盖 AudioEngine 实际触达的 surface ----

interface FakeAudioBuffer {
  duration: number;
  sampleRate: number;
  name: string;
}

class FakeParam {
  value = 1;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}

class FakeGainNode {
  gain = new FakeParam();
  connect() {}
  disconnect() {}
}

class FakeSourceNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startWhen = -1;
  startOffset = -1;
  stopped = false;
  connect() {}
  disconnect() {}
  start(when = 0, offset = 0) {
    this.startWhen = when;
    this.startOffset = offset;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: FakeSourceNode[] = [];
  /** 设置后 decodeAudioData 同步返回队列中的下一个缓冲；为 null 时挂起等待手动 resolve */
  autoDecodeQueue: FakeAudioBuffer[] | null = [];
  private pendingDecodes: Array<{ resolve: (b: FakeAudioBuffer) => void }> = [];

  createGain() {
    return new FakeGainNode();
  }
  createBufferSource() {
    const s = new FakeSourceNode();
    this.sources.push(s);
    return s;
  }
  decodeAudioData(): Promise<FakeAudioBuffer> {
    if (this.autoDecodeQueue) {
      const b = this.autoDecodeQueue.shift();
      if (!b) return Promise.reject(new Error('no fake buffer queued'));
      return Promise.resolve(b);
    }
    return new Promise((resolve) => this.pendingDecodes.push({ resolve }));
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  /** 手动完成第 i 个挂起的解码（按调用顺序） */
  resolveDecodeAt(i: number, b: FakeAudioBuffer) {
    const d = this.pendingDecodes.splice(i, 1)[0];
    if (!d) throw new Error(`no pending decode at ${i}`);
    d.resolve(b);
  }
  get pendingDecodeCount() {
    return this.pendingDecodes.length;
  }
  lastSource(): FakeSourceNode {
    const s = this.sources[this.sources.length - 1];
    if (!s) throw new Error('no source created yet');
    return s;
  }
}

(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;

function fakeFile(): File {
  return { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as unknown as File;
}
function buf(name: string, duration = 10): FakeAudioBuffer {
  return { duration, sampleRate: 48000, name };
}
/** AudioEngine 内部以 DOM 类型持有缓冲；测试按结构假实现传入。 */
function asAudioBuffer(b: FakeAudioBuffer): AudioBuffer {
  return b as unknown as AudioBuffer;
}
async function expectStale(p: Promise<unknown>, msg: string) {
  try {
    await p;
    failures++;
    console.error(`FAIL ${msg}: expected StaleDecodeError`);
  } catch (err) {
    ok(err instanceof StaleDecodeError, msg);
  }
}

async function main() {
  // ---- 场景 1：试听处理后结果期间导入新音频，解码成功后播放源归新文件 ----
  {
    const engine = new AudioEngine();
    const aOrig = buf('A-原始');
    const aProcessed = buf('A-处理后');
    const bOrig = buf('B-原始');

    // 通过 getContext() 预建 ctx，再把「下一次 decode 要返回的缓冲」排队
    const ctx = engine.getContext() as unknown as FakeAudioContext;
    ctx.autoDecodeQueue = [aOrig];
    await engine.decode(fakeFile());

    // 开始试听处理后音频：播放源切到处理后缓冲
    engine.setPlaybackBuffer(asAudioBuffer(aProcessed));
    engine.play(3);
    same(ctx.lastSource().buffer, aProcessed, '试听开始：播放源为处理后缓冲');

    // 试听期间导入另一段音频并成功解码
    ctx.autoDecodeQueue = [bOrig];
    await engine.decode(fakeFile());

    // 主播放 / 章节预览必须播放新文件原始缓冲，旧处理后缓冲不得残留
    engine.play(0);
    same(ctx.lastSource().buffer, bOrig, '新文件解码成功后主播放播放新文件原始缓冲');
    engine.play(1.5, 4); // 章节预览（带结束点）
    same(ctx.lastSource().buffer, bOrig, '新文件解码成功后章节预览播放新文件原始缓冲');
    engine.dispose();
  }

  // ---- 场景 2：被取代的旧解码完成时不得夺回播放源 ----
  {
    const engine = new AudioEngine();
    const ctx = engine.getContext() as unknown as FakeAudioContext;
    ctx.autoDecodeQueue = null; // 手动控制 decodeAudioData 完成时机

    const pOld = engine.decode(fakeFile()); // seq 1
    await Promise.resolve(); // 让旧解码越过 arrayBuffer、进入 decodeAudioData（此刻仍是最新）
    const pNew = engine.decode(fakeFile()); // seq 2
    await Promise.resolve(); // 让新解码也进入 decodeAudioData
    ok(ctx.pendingDecodeCount === 2, '两个文件的解码都在进行中');

    const newOrig = buf('新-原始');
    const newProcessed = buf('新-处理后');
    const oldOrig = buf('旧-原始');

    // 新文件先解码完成：取得播放源
    ctx.resolveDecodeAt(1, newOrig);
    await pNew;
    // 新文件的处理后试听开始
    engine.setPlaybackBuffer(asAudioBuffer(newProcessed));
    engine.play(0);
    same(ctx.lastSource().buffer, newProcessed, '新文件试听中：播放源为新文件处理后缓冲');

    // 旧文件的 decodeAudioData 随后完成：必须被拒绝，且不得改动任何播放源
    ctx.resolveDecodeAt(0, oldOrig);
    await expectStale(pOld, '旧解码完成被拒绝（StaleDecodeError）');
    engine.play(0);
    same(ctx.lastSource().buffer, newProcessed, '旧解码完成后播放源仍归新文件（试听缓冲）');
    engine.setPlaybackBuffer(null);
    engine.play(0);
    same(ctx.lastSource().buffer, newOrig, '结束试听后播放源为新文件原始缓冲');
    engine.dispose();
  }

  // ---- 场景 3：解码失败（坏文件）不改动当前播放源 ----
  {
    const engine = new AudioEngine();
    const ctx = engine.getContext() as unknown as FakeAudioContext;
    const orig = buf('原始');
    const processed = buf('处理后');
    ctx.autoDecodeQueue = [orig];
    await engine.decode(fakeFile());
    engine.setPlaybackBuffer(asAudioBuffer(processed));

    ctx.autoDecodeQueue = []; // 队列空 → decodeAudioData 拒绝
    let failed = false;
    try {
      await engine.decode(fakeFile());
    } catch {
      failed = true;
    }
    ok(failed, '坏文件解码失败');
    engine.play(1);
    same(ctx.lastSource().buffer, processed, '解码失败后试听播放源保持不变');
    engine.setPlaybackBuffer(null);
    engine.play(1);
    same(ctx.lastSource().buffer, orig, '解码失败后原始缓冲仍可播放');
    engine.dispose();
  }

  // ---- 场景 4：主播放从处理后试听切回原声时保留当前播放位置 ----
  {
    const engine = new AudioEngine();
    const ctx = engine.getContext() as unknown as FakeAudioContext;
    const orig = buf('原始', 100);
    const processed = buf('处理后', 100);
    ctx.autoDecodeQueue = [orig];
    await engine.decode(fakeFile());

    engine.setPlaybackBuffer(asAudioBuffer(processed));
    engine.play(5);
    ctx.currentTime = 2.5; // 试听了 2.5s → 当前位置 7.5s
    approx(engine.getTime(), 7.5, 1e-9, '试听中 getTime 返回处理后缓冲内的当前位置');

    // 主播放键切回原声：getTime() → setPlaybackBuffer(null) → play(t)
    const t = engine.getTime();
    engine.setPlaybackBuffer(null);
    engine.play(t);
    same(ctx.lastSource().buffer, orig, '切回原声后播放源为原始缓冲');
    approx(ctx.lastSource().startOffset, 7.5, 1e-9, '切回原声从试听位置继续播放');
    engine.dispose();
  }

  // ---- 场景 5：显式指定缓冲的 play 不受归属影响（逐处试听等）----
  {
    const engine = new AudioEngine();
    const ctx = engine.getContext() as unknown as FakeAudioContext;
    const orig = buf('原始');
    const other = buf('指定缓冲');
    ctx.autoDecodeQueue = [orig];
    await engine.decode(fakeFile());
    engine.play(0.6, 1.2, undefined, asAudioBuffer(other));
    same(ctx.lastSource().buffer, other, 'play 显式指定缓冲时优先使用');
    engine.play(0.6, 1.2);
    same(ctx.lastSource().buffer, orig, '未指定时回到归属缓冲（原始）');
    engine.dispose();
  }

  // ---- 场景 6：共用定位链路按操作前的播放状态处理（波形空白点击 / 章节跳转）----
  // App 侧 seek 的调用顺序契约：先读 engine.playing，再 stop + 切回原始缓冲，
  // 原先在播放则从目标秒数继续播放原声，原先暂停则只定位。若先 stop 再读
  // playing，结果恒为 false，播放中定位会意外停播（回归）。
  {
    const engine = new AudioEngine();
    const ctx = engine.getContext() as unknown as FakeAudioContext;
    const orig = buf('原始', 100);
    const processed = buf('处理后', 100);
    ctx.autoDecodeQueue = [orig];
    await engine.decode(fakeFile());

    // 6a：原声播放中定位 → 从目标秒数继续播放原声
    engine.play(2);
    {
      const wasPlaying = engine.playing; // 必须先于 stop 读取
      engine.stop();
      engine.setPlaybackBuffer(null);
      ok(wasPlaying, '播放中定位：操作前状态为播放中');
      if (wasPlaying) engine.play(6);
      same(ctx.lastSource().buffer, orig, '播放中定位：继续播放的是原始缓冲');
      approx(ctx.lastSource().startOffset, 6, 1e-9, '播放中定位：从目标秒数继续播放');
      ok(engine.playing, '播放中定位：定位后仍在播放');
    }

    // 6b：试听处理后音频中定位 → 切回原声并从目标秒数继续播放
    engine.setPlaybackBuffer(asAudioBuffer(processed));
    engine.play(1);
    same(ctx.lastSource().buffer, processed, '试听中：播放源为处理后缓冲');
    {
      const wasPlaying = engine.playing;
      engine.stop();
      engine.setPlaybackBuffer(null); // stopAudition：切回原始缓冲
      ok(wasPlaying, '试听中定位：操作前状态为播放中');
      if (wasPlaying) engine.play(4);
      same(ctx.lastSource().buffer, orig, '试听中定位：切回原始缓冲继续播放');
      approx(ctx.lastSource().startOffset, 4, 1e-9, '试听中定位：从目标秒数继续播放');
    }

    // 6c：暂停时定位 → 只定位，不启动新音源
    engine.stop(); // 暂停
    {
      const wasPlaying = engine.playing;
      engine.stop();
      engine.setPlaybackBuffer(null);
      const sourcesBefore = ctx.sources.length;
      ok(!wasPlaying, '暂停时定位：操作前状态为暂停');
      if (wasPlaying) engine.play(8);
      same(ctx.sources.length, sourcesBefore, '暂停时定位：不创建新音源');
      ok(!engine.playing, '暂停时定位：定位后保持暂停');
    }
    engine.dispose();
  }

  if (failures > 0) {
    console.error(`${failures} test(s) failed`);
    process.exit(1);
  } else {
    console.log('all playback-source tests passed');
  }
}

void main();
