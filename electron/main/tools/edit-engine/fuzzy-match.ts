/**
 * fuzzy-match.ts
 * 模糊匹配引擎的 TypeScript 完整实现。
 * 为什么存在：模型生成 edit 参数时极少逐字符精确命中原文（缩进/换行/转义/上下文边界
 * 常有差异），若要求精确匹配则编辑频繁失败、AI 被迫整文件重写——既费 token 又丢失
 * 未改动内容；本引擎按策略链逐级放宽一种差异，让 edit 在真实输出下仍能定位目标。
 * 作用：九层模糊匹配策略链：exact → trimmed → whitespace → indentation → escapes →
 * boundary → unicode → block-anchor → context-aware。
 * 配套：is_already_applied（已应用检测）、find_closest_lines（相近行提示）、
 * 位置映射（line/col ↔ offset）、行尾归一化。

 * 设计原则：
 * 1. 匹配失败不立即报错——按策略链逐级降级，每级放宽一种差异；
 * 2. 命中后返回 normalized old/new，替换时用归一化后的版本；
 * 3. 行尾差异（CRLF/LF）在匹配层就消除，不污染业务层。
 */

// ==================== 换行与 BOM ====================

export type LineEnding = '\r\n' | '\n' | '\r';

/** 检测文本的主导行尾 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return '\r\n';
  if (lf >= cr && lf > 0) return '\n';
  if (cr > 0) return '\r';
  return '\n';
}

/** 统一换行符（全转换：\r\n / \r / \n 一律转为目标 eol，默认 \n） */
export function normalizeLineEndings(text: string, eol: string = '\n'): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

/** 剥离 BOM */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 把字面 \n（反斜杠+n 两个字符）还原为真实换行。模型生成工具参数时常用字面 \n 表示换行。 */
export function unescapeLiteralNewlines(text: string): string {
  return text.replace(/\\n/g, '\n');
}

// ==================== 归一化 ====================

/** 空白归一化：行内连续空白折叠为单空格，去行首尾（保留换行） */
export function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n');
}

/** 缩进归一化：把每行行首空白折叠为单个空格（保留相对层级信息） */
export function normalizeIndentation(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const indent = line.match(/^(\s*)/)?.[1] ?? '';
      const rest = line.slice(indent.length);
      return (indent.length > 0 ? ' ' : '') + rest;
    })
    .join('\n');
}

/** 转义归一化：把字面 \n \t \r 序列还原为真实控制符（处理"粘贴时转义被保留"场景） */
export function normalizeEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
}

/** Unicode 归一化：NFKC（兼容分解+合成，处理全角/半角、隐形变体） */
export function normalizeUnicode(text: string): string {
  return text.normalize('NFKC');
}

/** 边界修剪：去掉行首尾空白（比 normalizeWhitespace 轻，不折叠行内空白） */
export function trimLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

// ==================== 位置映射 ====================

export interface Position {
  line: number; // 0-based
  col: number; // 0-based
}

/** offset → {line, col}（按 \n 计行） */
export function offsetToPosition(content: string, offset: number): Position {
  const before = content.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length - 1, col: lines[lines.length - 1].length };
}

/** {line, col} → offset（按 \n 计行） */
export function positionToOffset(content: string, pos: Position): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < pos.line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return Math.min(offset + pos.col, content.length);
}

// ==================== 匹配结果 ====================

export type MatchStrategy =
  | 'exact'
  | 'trimmed'
  | 'whitespace'
  | 'indentation'
  | 'escapes'
  | 'boundary'
  | 'unicode'
  | 'block-anchor'
  | 'context-aware';

export interface FuzzyMatchResult {
  matched: boolean;
  /** 已应用检测：old 已在 content 中（且 new 也已应用或 old==new） */
  alreadyApplied: boolean;
  strategy: MatchStrategy | null;
  startOffset: number;
  endOffset: number;
  /** 归一化后的 old/new（供替换使用，保证替换后行尾一致） */
  normalizedOld: string;
  normalizedNew: string;
}

// ==================== 已应用检测 ====================

/**
 * 检测编辑是否已应用：
 * - old 不在 content 中但 new 在 → 已应用（no_change）
 * - old == new（空操作）→ 已应用
 */
export function isAlreadyApplied(content: string, oldString: string, newString: string): boolean {
  const normContent = normalizeLineEndings(content);
  const normOld = normalizeLineEndings(oldString);
  const normNew = normalizeLineEndings(newString);

  if (normOld === normNew) return true;
  if (!normContent.includes(normOld)) {
    return normContent.includes(normNew);
  }
  // old 在 content 中：检查替换后是否等价于 new（防止重复应用同一编辑的变体）
  const replaced = normContent.replace(normOld, normNew);
  return replaced === normContent && normContent.includes(normNew) && normOld !== normNew;
}

// ==================== 九层策略 ====================

interface StrategyContext {
  content: string; // 已按 \n 归一化
  oldString: string; // 已按 \n 归一化
  newString: string; // 已按 \n 归一化
}

interface StrategyHit {
  start: number;
  end: number;
  matchedOld: string;
  matchedNew: string;
}

/** 在 content 中查找 old 的精确出现（可选范围限定） */
function findExact(content: string, old: string, fromIndex = 0): number {
  return content.indexOf(old, fromIndex);
}

/** 策略 1：精确匹配 */
function strategyExact(ctx: StrategyContext): StrategyHit | null {
  const idx = findExact(ctx.content, ctx.oldString);
  if (idx === -1) return null;
  return { start: idx, end: idx + ctx.oldString.length, matchedOld: ctx.oldString, matchedNew: ctx.newString };
}

/** 策略 2：行修剪匹配（old 每行首尾空白修剪后匹配） */
function strategyTrimmed(ctx: StrategyContext): StrategyHit | null {
  const contentTrimmed = trimLines(ctx.content);
  const oldTrimmed = trimLines(ctx.oldString);
  const idx = findExact(contentTrimmed, oldTrimmed);
  if (idx === -1) return null;
  // 把 contentTrimmed 中的位置映射回原 content：因为修剪会改变长度，用搜索方式
  // 简化：直接找原 content 中修剪后匹配的起始（逐行对齐）
  const contentLines = ctx.content.split('\n');
  const oldLines = oldTrimmed.split('\n');
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== oldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = positionToOffset(ctx.content, { line: i, col: 0 });
      const end = positionToOffset(ctx.content, { line: i + oldLines.length - 1, col: contentLines[i + oldLines.length - 1].length });
      return { start, end, matchedOld: oldTrimmed, matchedNew: trimLines(ctx.newString) };
    }
  }
  return null;
}

/** 策略 3：空白归一化匹配（行内空白折叠 + 行修剪） */
function strategyWhitespace(ctx: StrategyContext): StrategyHit | null {
  const contentNorm = normalizeWhitespace(ctx.content);
  const oldNorm = normalizeWhitespace(ctx.oldString);
  const idx = findExact(contentNorm, oldNorm);
  if (idx === -1) return null;
  // 映射回原 content：逐行对齐归一化后的行
  const contentLines = ctx.content.split('\n');
  const oldLines = oldNorm.split('\n');
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizeWhitespace(contentLines[i + j]) !== oldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = positionToOffset(ctx.content, { line: i, col: 0 });
      const end = positionToOffset(ctx.content, { line: i + oldLines.length - 1, col: contentLines[i + oldLines.length - 1].length });
      return { start, end, matchedOld: oldNorm, matchedNew: normalizeWhitespace(ctx.newString) };
    }
  }
  return null;
}

/** 策略 4：缩进灵活匹配（行首缩进折叠为单空格） */
function strategyIndentation(ctx: StrategyContext): StrategyHit | null {
  const contentNorm = normalizeIndentation(ctx.content);
  const oldNorm = normalizeIndentation(ctx.oldString);
  const idx = findExact(contentNorm, oldNorm);
  if (idx === -1) return null;
  const contentLines = ctx.content.split('\n');
  const oldLines = oldNorm.split('\n');
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizeIndentation(contentLines[i + j]) !== oldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = positionToOffset(ctx.content, { line: i, col: 0 });
      const end = positionToOffset(ctx.content, { line: i + oldLines.length - 1, col: contentLines[i + oldLines.length - 1].length });
      return { start, end, matchedOld: oldNorm, matchedNew: normalizeIndentation(ctx.newString) };
    }
  }
  return null;
}

/** 策略 5：转义归一化匹配（字面 \n \t 还原） */
function strategyEscapes(ctx: StrategyContext): StrategyHit | null {
  const contentNorm = normalizeEscapes(ctx.content);
  const oldNorm = normalizeEscapes(ctx.oldString);
  const idx = findExact(contentNorm, oldNorm);
  if (idx === -1) return null;
  // 转义还原改变长度，位置映射用逐行对齐（转义通常在行内，行数不变）
  const contentLines = ctx.content.split('\n');
  const oldLines = oldNorm.split('\n');
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizeEscapes(contentLines[i + j]) !== oldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = positionToOffset(ctx.content, { line: i, col: 0 });
      const end = positionToOffset(ctx.content, { line: i + oldLines.length - 1, col: contentLines[i + oldLines.length - 1].length });
      return { start, end, matchedOld: oldNorm, matchedNew: normalizeEscapes(ctx.newString) };
    }
  }
  return null;
}

/** 策略 6：边界修剪匹配（行首尾空白修剪，行内保留） */
function strategyBoundary(ctx: StrategyContext): StrategyHit | null {
  return strategyTrimmed(ctx);
}

/** 策略 7：Unicode 归一化匹配（NFKC） */
function strategyUnicode(ctx: StrategyContext): StrategyHit | null {
  const contentNorm = normalizeUnicode(ctx.content);
  const oldNorm = normalizeUnicode(ctx.oldString);
  const idx = findExact(contentNorm, oldNorm);
  if (idx === -1) return null;
  const contentLines = ctx.content.split('\n');
  const oldLines = oldNorm.split('\n');
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizeUnicode(contentLines[i + j]) !== oldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = positionToOffset(ctx.content, { line: i, col: 0 });
      const end = positionToOffset(ctx.content, { line: i + oldLines.length - 1, col: contentLines[i + oldLines.length - 1].length });
      return { start, end, matchedOld: oldNorm, matchedNew: normalizeUnicode(ctx.newString) };
    }
  }
  return null;
}

/** 策略 8：块锚定匹配（按行块匹配，忽略块内行差异，取最长公共子序列风格） */
function strategyBlockAnchor(ctx: StrategyContext): StrategyHit | null {
  const contentLines = ctx.content.split('\n');
  const oldLines = ctx.oldString.split('\n');
  if (oldLines.length === 0) return null;
  // 用 old 的首尾行锚定候选块，中间行做部分匹配（允许少量差异）
  const firstLine = oldLines[0].trim();
  const lastLine = oldLines[oldLines.length - 1].trim();
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue;
    const candidateEnd = i + oldLines.length - 1;
    if (candidateEnd >= contentLines.length) continue;
    if (contentLines[candidateEnd].trim() !== lastLine) continue;
    // 中间行：允许最多 30% 行不匹配（容忍行内容漂移）
    let mismatches = 0;
    const tolerance = Math.max(1, Math.floor(oldLines.length * 0.3));
    for (let j = 1; j < oldLines.length - 1; j++) {
      if (contentLines[i + j].trim() !== oldLines[j].trim()) {
        mismatches++;
        if (mismatches > tolerance) break;
      }
    }
    if (mismatches <= tolerance) {
      const start = positionToOffset(ctx.content, { line: i, col: 0 });
      const end = positionToOffset(ctx.content, { line: candidateEnd, col: contentLines[candidateEnd].length });
      return { start, end, matchedOld: ctx.oldString, matchedNew: ctx.newString };
    }
  }
  return null;
}

/** 策略 9：上下文感知匹配（old 加前后各 1 行上下文后匹配，容忍上下文轻微差异） */
function strategyContextAware(ctx: StrategyContext): StrategyHit | null {
  const contentLines = ctx.content.split('\n');
  const oldLines = ctx.oldString.split('\n');
  if (oldLines.length === 0) return null;
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j++) {
      const cLine = normalizeWhitespace(contentLines[i + j]);
      const oLine = normalizeWhitespace(oldLines[j]);
      if (cLine !== oLine) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const start = positionToOffset(ctx.content, { line: i, col: 0 });
      const end = positionToOffset(ctx.content, { line: i + oldLines.length - 1, col: contentLines[i + oldLines.length - 1].length });
      return { start, end, matchedOld: ctx.oldString, matchedNew: ctx.newString };
    }
  }
  return null;
}

// ==================== 策略链 ====================

export type StrategyFn = (ctx: StrategyContext) => StrategyHit | null;

/** 策略链定义（先精确后模糊，每级放宽一种差异） */
export function getStrategies(): Array<{ name: MatchStrategy; fn: StrategyFn }> {
  return [
    { name: 'exact', fn: strategyExact },
    { name: 'trimmed', fn: strategyTrimmed },
    { name: 'whitespace', fn: strategyWhitespace },
    { name: 'indentation', fn: strategyIndentation },
    { name: 'escapes', fn: strategyEscapes },
    { name: 'boundary', fn: strategyBoundary },
    { name: 'unicode', fn: strategyUnicode },
    { name: 'block-anchor', fn: strategyBlockAnchor },
    { name: 'context-aware', fn: strategyContextAware },
  ];
}

// ==================== 主入口 ====================

export interface ApplyEditResult {
  content: string;
  result: FuzzyMatchResult;
}

/**
 * 模糊匹配主函数：按策略链逐级尝试，返回首个命中。
 * content/oldString/newString 任意行尾均可（内部归一化，替换后按 content 原行尾还原）。
 */
export function fuzzyMatch(content: string, oldString: string, newString: string): FuzzyMatchResult {
  const normContent = normalizeLineEndings(stripBom(content), '\n');
  const normOldRaw = normalizeLineEndings(oldString, '\n');
  // 模型生成工具参数时，常用字面 \n（反斜杠+n 两个字符）表示换行（典型：Edit 的 old_string 多行匹配）。
  // 原样含字面 \n 且不含真实换行时，转换后匹配（兼容模型习惯；\\n 双反斜杠+n 是真实文本，保护不转）。
  const normOld = normOldRaw.includes('\\n') && !normOldRaw.includes('\n') && normContent.includes('\n')
    ? unescapeLiteralNewlines(normOldRaw)
    : normOldRaw;
  const normNew = normalizeLineEndings(newString, '\n');

  const notFound: FuzzyMatchResult = {
    matched: false,
    alreadyApplied: false,
    strategy: null,
    startOffset: -1,
    endOffset: -1,
    normalizedOld: normOld,
    normalizedNew: normNew,
  };

  if (isAlreadyApplied(normContent, normOld, normNew)) {
    return {
      matched: false,
      alreadyApplied: true,
      strategy: null,
      startOffset: -1,
      endOffset: -1,
      normalizedOld: normOld,
      normalizedNew: normNew,
    };
  }

  const ctx: StrategyContext = { content: normContent, oldString: normOld, newString: normNew };
  for (const { name, fn } of getStrategies()) {
    const hit = fn(ctx);
    if (hit) {
      return {
        matched: true,
        alreadyApplied: false,
        strategy: name,
        startOffset: hit.start,
        endOffset: hit.end,
        normalizedOld: hit.matchedOld,
        normalizedNew: hit.matchedNew,
      };
    }
  }
  return notFound;
}

/**
 * 应用编辑：匹配成功则替换并保持原文件行尾，返回新 content。
 * 关键：fuzzyMatch 在归一化（\n）空间计算偏移，替换也必须在归一化空间做，
 * 最后再转回原文件行尾——否则 CRLF 文件会因 \r\n 占 2 字符导致偏移错位。
 * 返回的 content 行尾统一为原文件主导行尾（eol），且保留 BOM。
 */
export function applyEdit(content: string, oldString: string, newString: string): ApplyEditResult {
  const eol = detectLineEnding(content);
  const hasBom = content.charCodeAt(0) === 0xfeff;
  const body = hasBom ? content.slice(1) : content;

  // 归一化到 \n 空间做匹配与替换（偏移一致）
  const bodyNorm = normalizeLineEndings(body, '\n');
  const result = fuzzyMatch(bodyNorm, oldString, newString);
  if (!result.matched) {
    return { content, result };
  }

  const replacedNorm =
    bodyNorm.slice(0, result.startOffset) +
    result.normalizedNew +
    bodyNorm.slice(result.endOffset);

  const finalBody = normalizeLineEndings(replacedNorm, eol);
  const finalContent = hasBom ? '\uFEFF' + finalBody : finalBody;
  return { content: finalContent, result };
}

// ==================== 相近行提示（Did you mean?） ====================

/** 行级相似度（0-1）：基于字符集合 + 编辑距离的轻量近似 */
export function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const longer = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);
  return 1 - dist / longer;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = new Array(n + 1).fill(0);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/** 在 content 中找与 target 最相似的若干行（按相似度降序） */
export function findClosestLines(content: string, target: string, maxResults = 5): Array<{ line: string; lineNumber: number; similarity: number }> {
  const targetNorm = normalizeWhitespace(target);
  const results: Array<{ line: string; lineNumber: number; similarity: number }> = [];
  const seen = new Set<string>();

  const lines = normalizeLineEndings(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (seen.has(line)) continue;
    const sim = lineSimilarity(normalizeWhitespace(line), targetNorm);
    if (sim > 0.3) {
      results.push({ line, lineNumber: i + 1, similarity: sim });
      seen.add(line);
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, maxResults);
}

/** 生成"Did you mean?"提示文本 */
export function buildDidYouMean(content: string, target: string, maxResults = 5): string {
  const closest = findClosestLines(content, target, maxResults);
  if (closest.length === 0) return '';
  return (
    '\nDid you mean one of these?（相近行候选：）\n' +
    closest
      .map((c) => `  L${c.lineNumber} (${Math.round(c.similarity * 100)}%): ${c.line.slice(0, 120)}`)
      .join('\n')
  );
}
