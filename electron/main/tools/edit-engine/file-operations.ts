/**
 * file-operations.ts
 * 文件操作引擎核心段的 TypeScript 实现：
 * 为什么存在：edit 工具必须保证「改坏即还原、中途崩溃不留半文件」的写入安全——
 * 直接 writeFileSync 覆盖目标文件在写入中途崩溃会留下截断文件，且旧内容永久丢失；
 * 本模块把原子写（临时文件+rename）作为硬约束，是 edit 工具落地层不可绕过的安全边界。
 * 作用：原子写（临时文件+rename）、行尾保持、BOM 处理、写后 sha256 验证、模糊应用。
 * 与 fuzzy-match.ts 配合：读 → 模糊匹配 → 原子写回 → 验证。
 * 设计原则：
 * 1. 写文件永不直接覆盖——先写同目录临时文件再 rename，中途崩溃不留半个文件；
 * 2. 写前检测原文件行尾/BOM，写后保持，CRLF 文件不会变 LF；
 * 3. 写后立即 re-read + sha256 对比，验证落盘真实成功。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { applyEdit, detectLineEnding, stripBom, normalizeLineEndings, buildDidYouMean, type LineEnding } from './fuzzy-match';

// ==================== 读 ====================

export interface ReadResult {
  content: string; // 已剥离 BOM
  hadBom: boolean;
  lineEnding: LineEnding;
  size: number;
}

/** 读文件：剥离 BOM + 检测行尾 + 检测二进制 */
export function readFileSafe(filePath: string): ReadResult {
  const buf = fs.readFileSync(filePath);
  const hadBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const content = buf.toString('utf8');
  // 二进制检测：含 NUL 字节或大量无效 UTF-8 视为二进制
  const isBinary = buf.includes(0) || (content.match(/\uFFFD/g) || []).length > buf.length * 0.01;
  if (isBinary) {
    throw new Error(`文件是二进制或不可读编码（${path.basename(filePath)}）`);
  }
  return {
    content: stripBom(content),
    hadBom,
    lineEnding: detectLineEnding(content),
    size: buf.length,
  };
}

// ==================== 原子写 ====================

/** 生成同目录临时文件路径 */
function tempPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

/**
 * 原子写：先写同目录临时文件（fsync 落盘）再 rename 覆盖。
 * 失败时清理临时文件，原文件不受影响。
 */
export function atomicWrite(filePath: string, content: string): void {
  const tmp = tempPathFor(filePath);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, content, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 清理失败忽略 */
    }
    throw err;
  }
}

// ==================== 写（带行尾/BOM 保持） ====================

export interface WriteOptions {
  /** 保持原文件行尾（默认 true；新文件用系统默认 \r\n 在 Windows） */
  preserveLineEnding?: boolean;
  /** 保持原文件 BOM（默认 true；新文件不添加） */
  preserveBom?: boolean;
}

export interface WriteResult {
  ok: boolean;
  path: string;
  bytes: number;
  verified: boolean;
}

/**
 * 写文件：原子写 + 行尾/BOM 保持 + 写后 sha256 验证。
 * 文件已存在时保持其行尾与 BOM；新文件按平台默认。
 */
export function writeFileSafe(filePath: string, content: string, options: WriteOptions = {}): WriteResult {
  const { preserveLineEnding = true, preserveBom = true } = options;

  let existing: ReadResult | null = null;
  try {
    existing = readFileSafe(filePath);
  } catch {
    existing = null; // 不存在或二进制——二进制文件拒绝覆盖
    if (fs.existsSync(filePath)) {
      throw new Error(`拒绝覆盖二进制/不可读文件：${filePath}`);
    }
  }

  let finalContent = content;
  let hadBom = false;

  if (existing) {
    if (preserveLineEnding) {
      finalContent = normalizeLineEndings(finalContent, existing.lineEnding);
    }
    hadBom = existing.hadBom;
    if (preserveBom && hadBom) {
      finalContent = '\uFEFF' + finalContent;
    }
  }
  // 新文件：保持内容原样（AI 写什么就是什么，不强制平台行尾）

  atomicWrite(filePath, finalContent);

  // 写后验证：re-read + sha256 对比
  const written = fs.readFileSync(filePath);
  const expect = Buffer.from(finalContent, 'utf8');
  const verified = written.equals(expect);

  return {
    ok: true,
    path: filePath,
    bytes: Buffer.byteLength(finalContent, 'utf8'),
    verified,
  };
}

// ==================== 模糊应用（编辑文件） ====================

export interface ApplyEditToFileResult {
  ok: boolean;
  matched: boolean;
  alreadyApplied: boolean;
  strategy: string | null;
  verified: boolean;
  error?: string;
}

/**
 * 读文件 → fuzzyMatch 应用编辑 → 原子写回。
 * 匹配失败时给出 Did you mean 提示（经 error 字段）。
 */
export function applyEditToFile(filePath: string, oldString: string, newString: string): ApplyEditToFileResult {
  let readResult: ReadResult;
  try {
    readResult = readFileSafe(filePath);
  } catch (err) {
    return { ok: false, matched: false, alreadyApplied: false, strategy: null, verified: false, error: `读取失败: ${(err as Error).message}` };
  }

  const { content, result } = applyEdit(readResult.content, oldString, newString);

  if (result.alreadyApplied) {
    return { ok: true, matched: false, alreadyApplied: true, strategy: null, verified: true };
  }
  if (!result.matched) {
    const hint = buildDidYouMean(readResult.content, oldString);
    return {
      ok: false,
      matched: false,
      alreadyApplied: false,
      strategy: null,
      verified: false,
      error: `未找到匹配${hint}`,
    };
  }

  try {
    // 保持原文件行尾/BOM：content 来自 readFileSafe（无 BOM），替换后按原行尾还原
    let finalContent = normalizeToLineEnding(content, readResult.lineEnding);
    if (readResult.hadBom) finalContent = '\uFEFF' + finalContent;
    atomicWrite(filePath, finalContent);

    const written = fs.readFileSync(filePath);
    const expect = Buffer.from(finalContent, 'utf8');
    const verified = written.equals(expect);

    return {
      ok: true,
      matched: true,
      alreadyApplied: false,
      strategy: result.strategy,
      verified,
    };
  } catch (err) {
    return { ok: false, matched: true, alreadyApplied: false, strategy: null, verified: false, error: `写入失败: ${(err as Error).message}` };
  }
}

function normalizeToLineEnding(content: string, eol: LineEnding): string {
  return normalizeLineEndings(content, eol);
}

// ==================== 行 diff（ToolCallSummary 的 addedLines/removedLines） ====================

/** 计算两个内容之间的增删行数（简版：按行 LCS diff）。 */
export function countLineDiff(oldContent: string, newContent: string): { added: number; removed: number } {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const m = oldLines.length
  const n = newLines.length
  // 大文件简化：只比较行数差异
  if (m > 5000 || n > 5000) {
    return {
      added: Math.max(0, n - m),
      removed: Math.max(0, m - n)
    }
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }
  const lcs = dp[m][n]
  return {
    added: n - lcs,
    removed: m - lcs
  }
}