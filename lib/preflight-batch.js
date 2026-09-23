'use strict';

/**
 * 批量印前校验汇总（preflight batch）。
 *
 * 输入为按上传顺序排列的逐文件结果：
 *   - 成功：{ file: { name, sizeBytes }, report }（report 为 preflightPdf 报告）；
 *   - 失败：{ file: { name, sizeBytes }, failure: { code, message } }
 *     （非 PDF / 损坏 / 加密 / 无页面等，仅记录该文件原因，不阻断其他文件）。
 *
 * 输出结构化批量报告：
 *   - files：逐文件通过状态与错误/警告/提示数量；成功文件附问题区段
 *     （不含逐页明细 pages——逐页明细请调单文件接口 /api/preflight）；
 *   - byCode：按问题代码汇总总次数（逐页问题按页计、文档级问题每文件计 1）
 *     与涉及文件（按输入顺序，含序号与文件名）。
 *
 * 该模块只做纯数据汇总，不触碰 PDF 字节；单文件校验、差异对比与拼版均不受影响。
 */

const { ISSUE_META } = require('./preflight');

/** 批量校验一次最多处理的文件数（前后端保持一致） */
const MAX_BATCH_FILES = 10;

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/**
 * 问题代码的展示元数据：优先使用当前版本的 ISSUE_META，
 * 报告条目自身字段作为兜底（与差异对比模块同一策略）。
 */
function describeCode(code, fallbackIssue) {
  const meta = ISSUE_META[code];
  if (meta) return { severity: meta.severity, title: meta.title };
  return {
    severity: (fallbackIssue && fallbackIssue.severity) || 'info',
    title: (fallbackIssue && fallbackIssue.title) || code,
  };
}

/** 单个问题的计次数：逐页问题按页数计，文档级问题（无页码）计 1 */
function issueAmount(issue) {
  return issue.pages && issue.pages.length ? issue.pages.length : 1;
}

function buildFileEntry(entry, index) {
  const file = {
    name: entry.file && entry.file.name ? entry.file.name : null,
    sizeBytes: entry.file && typeof entry.file.sizeBytes === 'number'
      ? entry.file.sizeBytes
      : null,
  };
  if (entry.failure) {
    return {
      index,
      file,
      ok: false,
      passed: false,
      failure: {
        code: entry.failure.code || 'unreadable',
        message: entry.failure.message || '未知错误',
      },
    };
  }
  const report = entry.report || {};
  const summary = report.summary || {};
  return {
    index,
    file,
    ok: true,
    passed: summary.passed === true,
    pageCount: report.pageCount ?? null,
    referenceSize: report.referenceSize || null,
    counts: {
      error: summary.error || 0,
      warning: summary.warning || 0,
      info: summary.info || 0,
      issuesTotal: summary.issuesTotal || 0,
      pagesWithIssues: summary.pagesWithIssues || 0,
    },
    issues: Array.isArray(report.issues) ? report.issues : [],
  };
}

/**
 * 汇总逐文件校验结果，生成批量报告（可直接 JSON 序列化下载）。
 *
 * @param {Array<{file:object, report?:object, failure?:{code:string, message:string}}>} entries
 * @returns {object} 批量报告
 */
function buildBatchReport(entries) {
  const files = (entries || []).map((entry, index) => buildFileEntry(entry, index));

  const totals = { error: 0, warning: 0, info: 0 };
  const codeMap = new Map();
  for (const fileEntry of files) {
    if (!fileEntry.ok) continue; // 失败文件不参与问题汇总
    totals.error += fileEntry.counts.error;
    totals.warning += fileEntry.counts.warning;
    totals.info += fileEntry.counts.info;
    for (const issue of fileEntry.issues) {
      if (!codeMap.has(issue.code)) {
        const meta = describeCode(issue.code, issue);
        codeMap.set(issue.code, {
          code: issue.code,
          severity: meta.severity,
          title: meta.title,
          total: 0,
          files: [],
        });
      }
      const bucket = codeMap.get(issue.code);
      bucket.total += issueAmount(issue);
      bucket.files.push({ index: fileEntry.index, name: fileEntry.file.name });
    }
  }

  // 按 严重级别（错误→警告→提示）→ 总次数降序 → 代码 排序，与单文件报告语义一致
  const byCode = [...codeMap.values()]
    .map((bucket) => ({ ...bucket, fileCount: bucket.files.length }))
    .sort((a, b) => {
      const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rankDiff !== 0) return rankDiff;
      if (a.total !== b.total) return b.total - a.total;
      return a.code.localeCompare(b.code);
    });

  const succeeded = files.filter((entry) => entry.ok).length;
  return {
    schemaVersion: 1,
    kind: 'preflight-batch',
    tool: 'booklet-imposer',
    generatedAt: new Date().toISOString(),
    maxFiles: MAX_BATCH_FILES,
    summary: {
      total: files.length,
      succeeded,
      failed: files.length - succeeded,
      passed: files.filter((entry) => entry.ok && entry.passed).length,
      error: totals.error,
      warning: totals.warning,
      info: totals.info,
    },
    files,
    byCode,
  };
}

module.exports = {
  MAX_BATCH_FILES,
  buildBatchReport,
  issueAmount,
};
