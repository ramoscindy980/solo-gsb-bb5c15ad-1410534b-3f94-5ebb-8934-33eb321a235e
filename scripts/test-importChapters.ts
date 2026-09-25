import {
  parseVttTimestamp,
  parseWebVTT,
  parseJSONChapters,
  parseChapterFile,
  buildImportPreview,
  applyImportedChapters,
} from '../src/utils/importChapters';
import { ImportPreviewSession } from '../src/utils/importPreviewSession';
import type { Chapter } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) {
    console.log(`ok ${msg}`);
  } else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${msg}${a === e ? '' : ` — expected ${e}, got ${a}`}`);
}
function expectThrow(fn: () => unknown, msg: string) {
  try {
    fn();
    failures++;
    console.error(`FAIL ${msg} — expected throw`);
  } catch {
    console.log(`ok ${msg}`);
  }
}

const D = 100;
const mk = (id: string, start: number, end: number, title = id): Chapter => ({ id, title, start, end });

// ---- timestamp parsing ----
eq(parseVttTimestamp('00:00:01.500'), 1.5, 'vtt timestamp basic');
eq(parseVttTimestamp('01:02:03'), 3723, 'vtt timestamp hms');
eq(parseVttTimestamp('00:01:02,25'), 62.25, 'vtt comma fraction 2 digits');
eq(parseVttTimestamp('99:59:59.999'), 359999.999, 'vtt large hours');
eq(parseVttTimestamp('00:05.000'), 5, 'vtt timestamp mm:ss.mmm');
eq(parseVttTimestamp('05:30'), 330, 'vtt timestamp mm:ss without fraction');
eq(parseVttTimestamp('00:05,5'), 5.5, 'vtt mm:ss comma fraction');
check(parseVttTimestamp('00:60:00') === null, 'vtt minutes >= 60 rejected');
check(parseVttTimestamp('00:00:60') === null, 'vtt seconds >= 60 rejected');
check(parseVttTimestamp('1:2') === null, 'vtt missing fields rejected');
check(parseVttTimestamp('5:30') === null, 'vtt short form needs two-digit minutes');
check(parseVttTimestamp('garbage') === null, 'vtt garbage rejected');

// ---- WebVTT parsing ----
{
  const vtt = [
    'WEBVTT - My Show',
    '',
    'NOTE a comment',
    'spanning',
    'two lines',
    '',
    '1',
    '00:00:00.000 --> 00:00:10.000',
    'Intro',
    '',
    '00:00:10,500 --> 00:01:00.000 align:start',
    '<b>Big</b> Topic &amp; more',
    '',
    'STYLE',
    '::cue { color: red }',
    '',
    'bad-cue',
    'soon --> later',
    'Broken',
  ].join('\n');
  const r = parseWebVTT(vtt);
  eq(r.format, 'vtt', 'webvtt format tag');
  eq(r.entries.length, 3, 'webvtt 3 cues (NOTE/STYLE skipped)');
  eq([r.entries[0].start, r.entries[0].end], [0, 10], 'webvtt cue 1 times');
  eq(r.entries[0].title, 'Intro', 'webvtt cue 1 title');
  eq([r.entries[1].start, r.entries[1].end], [10.5, 60], 'webvtt comma + cue settings tolerated');
  eq(r.entries[1].title, 'Big Topic & more', 'webvtt tags/entities stripped');
  check(r.entries[2].status === undefined && !!r.entries[2].error, 'webvtt bad timing flagged');
}
{
  const vtt = 'WEBVTT\n\n00:00:05.000 --> 00:00:15.000\nA\n\n00:00:20.000 --> 00:00:25.000\nB';
  const r = parseChapterFile('\uFEFF' + vtt);
  eq(r.format, 'vtt', 'BOM-prefixed webvtt detected');
  eq(r.entries.length, 2, 'BOM webvtt cues parsed');
}
{
  // NOTE with same-line comment text and a '-->' lookalike in its body must
  // not emit a phantom cue; REGION blocks skip too; MM:SS.mmm cues parse;
  // rows stay the real 1-based source lines (even across double blank lines)
  const vtt = [
    'WEBVTT', //                                        line 1
    '',
    'NOTE 说明：下一段要重录', //                         line 3
    '提到 00:05.000 --> 00:12.000 只是注释，不是 cue', //  line 4
    '',
    'REGION', //                                        line 6
    'id:fred',
    '',
    '', //                                              double blank separator
    '1', //                                             line 10
    '00:05.000 --> 00:12.000', //                       line 11
    '开场',
    '',
    'bad', //                                           line 14
    'soon --> later', //                                line 15
    'broken',
    '',
    '00:20.000 --> 00:30.000 align:start', //           line 18
    '正片',
  ].join('\n');
  const r = parseWebVTT(vtt);
  eq(r.entries.length, 3, 'NOTE-with-text / REGION skipped, no phantom cue');
  eq([r.entries[0].start, r.entries[0].end], [5, 12], 'mm:ss.mmm cue times parsed');
  eq(r.entries[0].row, 11, 'cue row is the source line of its timing line');
  eq(r.entries[0].title, '开场', 'cue title from the payload line');
  check(!!r.entries[1].error && r.entries[1].row === 15, 'single bad cue still flagged with its row');
  eq([r.entries[2].start, r.entries[2].end], [20, 30], 'later cue unaffected by the bad one');
  eq(r.entries[2].row, 18, 'row stays correct across double blank lines');
}
{
  // one bad cue does not block the others: preview flags it, valid rows apply
  const parsed = parseWebVTT([
    'WEBVTT',
    '',
    'NOTE 说明',
    '00:05.000 --> 00:12.000 注释里的假时间码',
    '',
    '00:05.000 --> 00:12.000',
    'A',
    '',
    'broken --> cue',
    '',
    '00:20.000 --> 00:30.000',
    'B',
  ].join('\n'));
  const preview = buildImportPreview(parsed, [], D);
  eq(
    preview.entries.map((e) => e.status),
    ['valid', 'invalid', 'valid'],
    'bad cue flagged invalid, others still importable',
  );
  eq(
    preview.counts,
    { total: 3, valid: 2, invalid: 1, outOfBounds: 0, overlap: 0 },
    'counts reflect the single bad cue',
  );
  const merged = applyImportedChapters(preview, [], D);
  eq(
    merged.map((c) => [c.start, c.end]),
    [
      [5, 12],
      [20, 30],
    ],
    'valid cues applied despite the bad one',
  );
}

// ---- JSON parsing ----
{
  const text = JSON.stringify({
    version: 1,
    qualityControl: { quietThresholdDb: -30, loudThresholdDb: -6 },
    chapters: [
      { id: 'x1', index: 1, title: 'A', start: 0, end: 10, duration: 10, qualityControl: {} },
      { id: 'x2', index: 2, title: 'B', start: '20.5', end: 30 },
      { id: 'x3', title: 'C', start: 'oops', end: 40 },
    ],
  });
  const r = parseJSONChapters(text);
  eq(r.entries.length, 3, 'json 3 rows');
  eq([r.entries[0].start, r.entries[0].end], [0, 10], 'json numeric times');
  eq(r.entries[1].start, 20.5, 'json string number accepted');
  check(!!r.entries[2].error, 'json bad start flagged');
}
{
  const r = parseChapterFile(JSON.stringify([{ title: 'A', start: 1, end: 2 }]));
  eq(r.format, 'json', 'bare array treated as json');
  eq(r.entries.length, 1, 'bare array one row');
}
expectThrow(() => parseChapterFile('{not json'), 'malformed file throws');
expectThrow(() => parseChapterFile('{"foo":1}'), 'json without chapters throws');
expectThrow(() => parseChapterFile('   '), 'empty file throws');

// ---- preview: statuses ----
{
  const parsed = parseWebVTT([
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:05.000', // valid (empty title ok)
    '',
    '00:00:10.000 --> 00:00:20.000', // overlaps existing [12,18]
    'hits existing',
    '',
    '00:00:30.000 --> 00:01:50.000', // end > duration 100
    'too long',
    '',
    '00:00:40.000 --> 00:00:40.100', // shorter than 0.2s
    'tiny',
    '',
    '00:00:50.000 --> 00:00:45.000', // end < start
    'reversed',
    '',
    '00:00:03.000 --> 00:00:08.000', // overlaps earlier valid cue
    'hits imported',
  ].join('\n'));
  const preview = buildImportPreview(parsed, [mk('e', 12, 18)], D);
  const statuses = preview.entries.map((e) => e.status);
  eq(statuses, ['valid', 'overlap', 'out-of-bounds', 'invalid', 'invalid', 'overlap'], 'preview statuses');
  eq(preview.counts, { total: 6, valid: 1, invalid: 2, outOfBounds: 1, overlap: 2 }, 'preview counts');
  check(preview.entries[0].reasons.some((r) => r.includes('标题为空')), 'empty title is a soft note, still valid');
}
{
  // cue entirely after audio end -> out of bounds
  const parsed = parseJSONChapters(JSON.stringify([{ title: 'A', start: 120, end: 130 }]));
  const preview = buildImportPreview(parsed, [], D);
  eq(preview.entries[0].status, 'out-of-bounds', 'start beyond duration -> out-of-bounds');
}
{
  // touching boundaries (end == next start) are NOT overlap
  const parsed = parseJSONChapters(
    JSON.stringify([
      { title: 'A', start: 10, end: 20 },
      { title: 'B', start: 20, end: 30 },
    ]),
  );
  const preview = buildImportPreview(parsed, [mk('e', 0, 10)], D);
  check(preview.entries.every((e) => e.status === 'valid'), 'edge-touching cues are valid');
}

// ---- apply: ids rebuilt, sorted, non-overlapping, titles numbered ----
{
  const parsed = parseJSONChapters(
    JSON.stringify([
      { id: 'should-not-survive', title: 'Later', start: 30, end: 40 },
      { id: 'also-not', title: '', start: 0, end: 5 },
      { id: 'bad', title: 'Bad', start: 90, end: 140 },
    ]),
  );
  const preview = buildImportPreview(parsed, [mk('keep', 10, 20, 'Existing')], D);
  eq(preview.counts.valid, 2, 'two valid rows for apply');
  const before = [mk('keep', 10, 20, 'Existing')];
  const merged = applyImportedChapters(preview, before, D);
  eq(merged.length, 3, 'apply keeps existing + adds valid');
  eq(
    merged.map((c) => [c.start, c.end]),
    [
      [0, 5],
      [10, 20],
      [30, 40],
    ],
    'applied result sorted',
  );
  check(merged[1].id === 'keep', 'existing id preserved');
  check(merged[0].id !== 'also-not' && merged[2].id !== 'should-not-survive', 'imported ids rebuilt');
  eq(merged[0].title, '章节 1', 'empty title numbered by sorted position');
  check(before.length === 1 && before[0].id === 'keep', 'apply does not mutate input');
}

// ---- apply failure: no partial write (throws, caller discards) ----
{
  // forge a preview whose "valid" rows actually overlap existing, simulating
  // stale/hand-crafted previews — the final guard must throw
  const parsed = parseJSONChapters(JSON.stringify([{ title: 'A', start: 0, end: 50 }]));
  let preview = buildImportPreview(parsed, [], D);
  preview = {
    ...preview,
    entries: preview.entries.map((e) => ({ ...e, status: 'valid' as const, reasons: [] })),
  };
  const before = [mk('keep', 10, 20)];
  expectThrow(() => applyImportedChapters(preview, before, D), 'overlapping apply throws');
  eq(before, [mk('keep', 10, 20)], 'nothing written on failure');
}
{
  // out-of-bounds forged valid row -> throws
  const parsed = parseJSONChapters(JSON.stringify([{ title: 'A', start: 90, end: 140 }]));
  let preview = buildImportPreview(parsed, [], D);
  preview = { ...preview, entries: preview.entries.map((e) => ({ ...e, status: 'valid' as const, reasons: [] })) };
  expectThrow(() => applyImportedChapters(preview, [], D), 'out-of-bounds apply throws');
}

// ---- re-import of this tool's export round-trips ----
{
  const exported = JSON.stringify({
    version: 1,
    chapters: [
      { id: 'a', index: 1, title: '一', start: 0, end: 12.345, duration: 12.345 },
      { id: 'b', index: 2, title: '二', start: 12.345, end: 60, duration: 47.655 },
    ],
  }, null, 2);
  const preview = buildImportPreview(parseChapterFile(exported), [], 60);
  check(preview.entries.every((e) => e.status === 'valid'), 'own JSON export all valid');
  const merged = applyImportedChapters(preview, [], 60);
  eq(
    merged.map((c) => `${c.title}:${c.start}-${c.end}`),
    ['一:0-12.345', '二:12.345-60'],
    'round-trip preserves timing/title',
  );
  check(new Set(merged.map((c) => c.id)).size === 2, 'imported ids unique');
}

// ---- 预览绑定音频载入批次（跨音频串档防护，含新旧音频同名场景）----
{
  const s = new ImportPreviewSession();
  // 首段音频成功载入 → 进入载入批次 1
  s.audioLoaded();
  const firstSession = s.session;

  // 选择章节文件 → 读取完成 → 预览绑定到当前批次，允许应用
  const t1 = s.beginRead();
  check(s.isCurrent(t1), 'session: 同批次内读取完成仍有效');
  s.bindPreview(t1);
  check(s.canApply(), 'session: 当前音频的有效预览允许应用');

  // 读取尚未完成就切换音频（新旧同名也走同一条 audioLoaded 路径）：
  // 旧读取作废、旧预览解绑，迟到的旧读取不得回填
  const t2 = s.beginRead();
  s.audioLoaded();
  check(s.session !== firstSession, 'session: 成功载入新音频即进入新批次（与文件名无关）');
  check(!s.isCurrent(t2), 'session: 切换音频后进行中的旧读取作废，不得回填预览');
  check(!s.canApply(), 'session: 切换音频后旧预览禁止应用（保留新音频已有章节）');

  // 预览已打开时切换音频：应用前核对来源失配 → 阻止写入
  const t3 = s.beginRead();
  s.bindPreview(t3);
  check(s.canApply(), 'session: 第二段音频的预览允许应用');
  s.audioLoaded(); // 又换音频（可同名）
  check(!s.canApply(), 'session: 预览已打开时换音频，应用前核对失配并阻止写入');

  // 新音频下重新选择章节文件：预览正常绑定、正常应用
  const t4 = s.beginRead();
  check(s.isCurrent(t4), 'session: 新批次内的新读取有效');
  s.bindPreview(t4);
  check(s.canApply(), 'session: 新音频的有效预览恢复可应用');

  // 同一批次内连续选两个文件：只认最新一次读取
  const t5 = s.beginRead();
  const t6 = s.beginRead();
  check(!s.isCurrent(t5) && s.isCurrent(t6), 'session: 连续选择文件只认最新读取');
  check(!s.canApply(), 'session: 重新选择文件后旧预览绑定一并解除');

  // 关闭预览（取消 / 应用完成）：进行中的读取作废、绑定解除
  s.bindPreview(t6);
  s.close();
  check(!s.isCurrent(t6) && !s.canApply(), 'session: 关闭预览作废旧读取并解除绑定');

  // 解码失败 / 未发生新载入：已打开的预览保持有效（当前音频没变）
  const t7 = s.beginRead();
  s.bindPreview(t7);
  check(s.canApply(), 'session: 未发生新载入时预览保持有效');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
