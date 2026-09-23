'use strict';

const assert = require('assert');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { preflightPdf } = require('../lib/preflight');
const { MAX_BATCH_FILES, buildBatchReport, issueAmount } = require('../lib/preflight-batch');

// ---------- 1. 纯函数单测 ----------

// 1.1 计次数：逐页问题按页数计，文档级问题（无页码）计 1
assert.strictEqual(issueAmount({ pages: [2, 3, 4] }), 3);
assert.strictEqual(issueAmount({ pages: [] }), 1);
assert.strictEqual(issueAmount({}), 1);

// 1.2 上限常量与接口/前端保持一致
assert.strictEqual(MAX_BATCH_FILES, 10);

// 1.3 混合成功/失败条目：逐文件状态、汇总计数、按代码聚合
{
  const reportA = {
    pageCount: 5,
    referenceSize: { width: 595.3, height: 841.9 },
    summary: { error: 1, warning: 0, info: 1, issuesTotal: 2, pagesWithIssues: 1, passed: false },
    issues: [
      { code: 'rotated_180', severity: 'error', title: '页面带 180° 旋转（上下颠倒）', pages: [5] },
      { code: 'blank_padding', severity: 'info', title: '页数不是 4 的倍数，拼版将补空白页', pages: [] },
    ],
  };
  const reportB = {
    pageCount: 4,
    referenceSize: { width: 595.3, height: 841.9 },
    summary: { error: 0, warning: 1, info: 0, issuesTotal: 1, pagesWithIssues: 3, passed: true },
    issues: [
      { code: 'transparency', severity: 'warning', title: '页面包含透明效果', pages: [1, 2, 3] },
    ],
  };
  const batch = buildBatchReport([
    { file: { name: 'a.pdf', sizeBytes: 100 }, report: reportA },
    { file: { name: 'broken.pdf', sizeBytes: 12 }, failure: { code: 'unreadable', message: '无法校验该 PDF：损坏' } },
    { file: { name: 'b.pdf', sizeBytes: 200 }, report: reportB },
    { file: { name: 'note.txt', sizeBytes: 5 }, failure: { code: 'not_pdf', message: '仅支持 PDF 文件' } },
  ]);

  assert.strictEqual(batch.kind, 'preflight-batch');
  assert.strictEqual(batch.schemaVersion, 1);
  assert.strictEqual(batch.tool, 'booklet-imposer');
  assert.strictEqual(batch.maxFiles, 10);
  assert.ok(batch.generatedAt);

  // 汇总：失败文件不参与错误/警告/提示计数
  assert.deepStrictEqual(batch.summary, {
    total: 4, succeeded: 2, failed: 2, passed: 1,
    error: 1, warning: 1, info: 1,
  });

  // 逐文件：顺序与输入一致，失败文件记录原因
  assert.strictEqual(batch.files.length, 4);
  assert.deepStrictEqual(batch.files.map((f) => f.index), [0, 1, 2, 3]);
  assert.strictEqual(batch.files[0].ok, true);
  assert.strictEqual(batch.files[0].passed, false);
  assert.strictEqual(batch.files[0].pageCount, 5);
  assert.deepStrictEqual(batch.files[0].counts, {
    error: 1, warning: 0, info: 1, issuesTotal: 2, pagesWithIssues: 1,
  });
  assert.strictEqual(batch.files[0].issues.length, 2);
  assert.strictEqual(batch.files[1].ok, false);
  assert.strictEqual(batch.files[1].passed, false);
  assert.strictEqual(batch.files[1].failure.code, 'unreadable');
  assert.match(batch.files[1].failure.message, /无法校验/);
  assert.strictEqual(batch.files[3].failure.code, 'not_pdf');

  // 按代码汇总：逐页问题按页计、文档级每文件计 1；涉及文件按输入顺序
  assert.strictEqual(batch.byCode.length, 3);
  const byCode = Object.fromEntries(batch.byCode.map((b) => [b.code, b]));
  assert.strictEqual(byCode.rotated_180.total, 1);
  assert.strictEqual(byCode.rotated_180.fileCount, 1);
  assert.deepStrictEqual(byCode.rotated_180.files, [{ index: 0, name: 'a.pdf' }]);
  assert.strictEqual(byCode.transparency.total, 3); // 3 页
  assert.deepStrictEqual(byCode.transparency.files, [{ index: 2, name: 'b.pdf' }]);
  assert.strictEqual(byCode.blank_padding.total, 1); // 文档级计 1
  // 排序：错误 → 警告 → 提示
  assert.deepStrictEqual(batch.byCode.map((b) => b.code),
    ['rotated_180', 'transparency', 'blank_padding']);
}

// 1.4 同一代码跨文件累计，涉及文件按输入顺序排列
{
  const mkReport = (pages) => ({
    pageCount: 4,
    summary: { error: 0, warning: 1, info: 0, issuesTotal: 1, pagesWithIssues: pages.length, passed: true },
    issues: [{ code: 'transparency', severity: 'warning', title: '页面包含透明效果', pages }],
  });
  const batch = buildBatchReport([
    { file: { name: 'x.pdf', sizeBytes: 1 }, report: mkReport([1, 2]) },
    { file: { name: 'y.pdf', sizeBytes: 1 }, report: mkReport([3]) },
  ]);
  assert.strictEqual(batch.byCode.length, 1);
  assert.strictEqual(batch.byCode[0].total, 3);
  assert.strictEqual(batch.byCode[0].fileCount, 2);
  assert.deepStrictEqual(batch.byCode[0].files.map((f) => f.name), ['x.pdf', 'y.pdf']);
}

// 1.5 未知问题代码：以报告条目自身字段兜底
{
  const batch = buildBatchReport([
    {
      file: { name: 'future.pdf', sizeBytes: 1 },
      report: {
        pageCount: 1,
        summary: { error: 0, warning: 0, info: 1, issuesTotal: 1, pagesWithIssues: 0, passed: true },
        issues: [{ code: 'future_check', severity: 'info', title: '未来检查项', pages: [] }],
      },
    },
  ]);
  assert.strictEqual(batch.byCode[0].code, 'future_check');
  assert.strictEqual(batch.byCode[0].severity, 'info');
  assert.strictEqual(batch.byCode[0].title, '未来检查项');
}

// 1.6 全部失败：byCode 为空，计数为 0
{
  const batch = buildBatchReport([
    { file: { name: 'bad.pdf', sizeBytes: 1 }, failure: { code: 'unreadable', message: 'x' } },
  ]);
  assert.strictEqual(batch.summary.total, 1);
  assert.strictEqual(batch.summary.succeeded, 0);
  assert.strictEqual(batch.summary.failed, 1);
  assert.strictEqual(batch.summary.error, 0);
  assert.strictEqual(batch.byCode.length, 0);
}

// ---------- 2. 端到端：真实 PDF 经 preflightPdf 后汇总 ----------

(async () => {
  // 5 页问题 PDF：第 5 页 180° 旋转（错误）+ 非 4 倍数补白（提示）
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i += 1) {
    const p = src.addPage([595.28, 841.89]);
    p.drawText(`PAGE ${i}`, { x: 80, y: 400, size: 24, font, color: rgb(0, 0, 0) });
  }
  const rotated = src.addPage([595.28, 841.89]);
  rotated.setRotation(degrees(180));
  rotated.drawText('ROTATED', { x: 80, y: 400, size: 24, font });
  const badBytes = Buffer.from(await src.save());

  // 4 页干净 PDF：无任何问题
  const clean = await PDFDocument.create();
  const cleanFont = await clean.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i += 1) {
    clean.addPage([595.28, 841.89]).drawText(`OK ${i}`, {
      x: 80, y: 400, size: 24, font: cleanFont,
    });
  }
  const cleanBytes = Buffer.from(await clean.save());

  const badReport = await preflightPdf(badBytes, { fileName: 'bad.pdf', sizeBytes: badBytes.length });
  const cleanReport = await preflightPdf(cleanBytes, { fileName: 'clean.pdf', sizeBytes: cleanBytes.length });

  const batch = buildBatchReport([
    { file: { name: 'bad.pdf', sizeBytes: badBytes.length }, report: badReport },
    { file: { name: 'enc.pdf', sizeBytes: 10 }, failure: { code: 'unreadable', message: '无法校验该 PDF：加密' } },
    { file: { name: 'clean.pdf', sizeBytes: cleanBytes.length }, report: cleanReport },
  ]);

  assert.strictEqual(batch.summary.total, 3);
  assert.strictEqual(batch.summary.succeeded, 2);
  assert.strictEqual(batch.summary.failed, 1);
  assert.strictEqual(batch.summary.passed, 1);
  assert.strictEqual(batch.summary.error, 1);
  assert.strictEqual(batch.summary.info, 1);

  assert.strictEqual(batch.files[0].passed, false);
  assert.strictEqual(batch.files[2].passed, true);
  assert.strictEqual(batch.files[2].issues.length, 0);

  const rotatedBucket = batch.byCode.find((b) => b.code === 'rotated_180');
  assert.strictEqual(rotatedBucket.severity, 'error');
  assert.strictEqual(rotatedBucket.total, 1);
  assert.deepStrictEqual(rotatedBucket.files, [{ index: 0, name: 'bad.pdf' }]);
  const blankBucket = batch.byCode.find((b) => b.code === 'blank_padding');
  assert.strictEqual(blankBucket.total, 1);

  console.log('✅ 批量印前校验汇总测试通过：逐文件状态、失败隔离、按代码汇总（总次数/涉及文件）');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
