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
 *   暂停时定位不启动新音源；
 * - 自然结束定位：完整播放 / 处理后试听至尾端时内部时钟停在该缓冲的
 *   真实终点（而非起播点），章节 / 命中等限时试听停在本次片段终点，
 *   播放中读数不越过自然终点；被新播放取代的旧结束事件与手动暂停
 *   触发的结束事件都不得改写位置、不得触发 onEnded。
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
  startDuration: number | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start(when = 0, offset = 0, duration?: number) {
    this.startWhen = when;
    this.startOffset = offset;
    this.startDuration = duration ?? null;
  }
  stop() {
    this.stopped = true;
  }
  /** 模拟浏览器在音源自然播完 / 被 stop() 后异步派发的结束事件 */
  fireEnded() {
    this.onended?.();
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

  // ---- 场景 7：自然结束定位 —— 内部时钟停在本次播放的真实终点 ----
  {
    const engine = new AudioEngine();
    const ctx = engine.getContext() as unknown as FakeAudioContext;
    const orig = buf('原始', 100);
    const processed = buf('处理后', 80);
    ctx.autoDecodeQueue = [orig];
    await engine.decode(fakeFile());

    let ended = 0;
    let endedAt = -1;
    engine.onEnded = () => {
      ended++;
      endedAt = engine.getTime(); // App 在 onEnded 里以此同步界面播放头
    };

    // 7a：从任意位置完整播放至尾端 → 停在缓冲真实终点，而非起播点
    engine.play(30);
    ctx.currentTime = 70; // 30 + 70 = 100，恰好播到末尾
    ctx.lastSource().fireEnded();
    approx(engine.getTime(), 100, 1e-9, '完整播放自然结束：内部时间停在缓冲终点');
    approx(endedAt, 100, 1e-9, '完整播放自然结束：onEnded 时界面可同步到缓冲终点');
    same(ended, 1, '完整播放自然结束：onEnded 触发一次');
    ok(!engine.playing, '自然结束后不再处于播放态');

    // 7b：处理后试听至尾端 → 停在处理后缓冲的真实终点
    engine.setPlaybackBuffer(asAudioBuffer(processed));
    engine.play(70);
    ctx.currentTime = 80; // 70 + (80-70) = 播到处理后缓冲末尾
    ctx.lastSource().fireEnded();
    approx(engine.getTime(), 80, 1e-9, '处理后试听至尾端：停在该缓冲真实终点');
    approx(endedAt, 80, 1e-9, '处理后试听至尾端：onEnded 时界面同步到该缓冲终点');
    same(ended, 2, '处理后试听结束：onEnded 再触发一次');
    engine.setPlaybackBuffer(null);

    // 7c：章节 / 命中等限时试听 → 停在本次片段终点
    engine.play(10, 20);
    approx(ctx.lastSource().startDuration ?? -1, 10, 1e-9, '限时试听：音源带片段时长启动');
    ctx.currentTime = 90; // 10 + (90-80) = 20，播到片段终点
    ctx.lastSource().fireEnded();
    approx(engine.getTime(), 20, 1e-9, '限时试听自然结束：停在本次片段终点');
    approx(endedAt, 20, 1e-9, '限时试听自然结束：onEnded 时界面同步到片段终点');
    same(ended, 3, '限时试听结束：onEnded 再触发一次');

    // 7d：播放中读数不越过自然终点（onended 派发前的帧也不超读）
    engine.play(95);
    ctx.currentTime = 120; // 95 + (120-90) 远超缓冲末尾
    approx(engine.getTime(), 100, 1e-9, '播放中读数被钳制在自然终点');
    engine.dispose();
  }

  // ---- 场景 8：旧结束事件 / 手动暂停的结束事件不得改写位置 ----
  {
    const engine = new AudioEngine();
    const ctx = engine.getContext() as unknown as FakeAudioContext;
    const orig = buf('原始', 100);
    ctx.autoDecodeQueue = [orig];
    await engine.decode(fakeFile());

    let ended = 0;
    engine.onEnded = () => {
      ended++;
    };

    // 8a：被新播放取代的旧音源，其结束事件不得改写新播放的位置与状态
    engine.play(10);
    const oldSrc = ctx.lastSource();
    engine.play(40); // 取代旧音源（旧音源被 stop，浏览器随后异步派发其 onended）
    ctx.currentTime = 1;
    oldSrc.fireEnded();
    ok(engine.playing, '旧结束事件不影响新播放的播放态');
    approx(engine.getTime(), 41, 1e-9, '旧结束事件不改写新播放的位置');
    same(ended, 0, '旧结束事件不触发 onEnded');

    // 8b：手动暂停保留当时位置，暂停引发的结束事件不得改写、不得触发 onEnded
    ctx.currentTime = 6; // 40 + (6-0) = 46
    const pausedAt = engine.pause();
    approx(pausedAt, 46, 1e-9, '手动暂停：返回当时位置');
    approx(engine.getTime(), 46, 1e-9, '手动暂停：内部时钟停在当时位置');
    oldSrc.fireEnded(); // 旧音源补发（幂等）
    ctx.sources[ctx.sources.length - 1].fireEnded(); // 被暂停 stop 的音源派发 onended
    approx(engine.getTime(), 46, 1e-9, '手动暂停的结束事件不改写位置');
    same(ended, 0, '手动暂停不触发 onEnded');

    // 8c：暂停后从当时位置继续播放，自然结束仍停在缓冲终点
    engine.play(engine.getTime());
    approx(ctx.lastSource().startOffset, 46, 1e-9, '暂停后继续播放：从当时位置起播');
    ctx.currentTime = 60; // 46 + (60-6) = 100
    ctx.lastSource().fireEnded();
    approx(engine.getTime(), 100, 1e-9, '继续播放至尾端：停在缓冲终点');
    same(ended, 1, '继续播放自然结束：onEnded 触发一次');
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
