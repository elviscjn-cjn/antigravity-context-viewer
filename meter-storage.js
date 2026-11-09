'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 安全保存 JSON 文件（原子重命名替换与完整性校验）
 *
 * 核心设计准则：
 * 1. 同目录唯一临时文件写入，确保在同一文件系统分区下进行原子替换
 * 2. 写入临时文件后执行替换前校验（JSON 解析与自定义业务校验）
 * 3. 使用 renameSync 进行替换；替换失败时保留原文件，严禁退回直接覆盖或先删除后重命名
 * 4. 临时文件清理异常不得覆盖原始 rename 错误
 * 5. 替换后进行读回校验，区分替换前失败与替换后校验失败
 * 6. 不承诺跨多文件全局事务原子性，明确单文件安全替换边界
 */
function safeWriteJsonSync(targetPath, data, options = {}) {
  const fsImpl = options.fs || fs;
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, phase: 'argument', error: '目标文件路径无效', path: targetPath };
  }

  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);

  try {
    fsImpl.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, phase: 'mkdir', error: err?.message || '创建父目录失败', path: resolved };
  }

  // 目标路径如果已存在且为目录，直接拒绝以防破坏
  try {
    if (fsImpl.existsSync(resolved)) {
      const st = fsImpl.statSync(resolved);
      if (st.isDirectory()) {
        return { ok: false, phase: 'validate_target', error: '目标路径是一个目录，无法写入文件', path: resolved };
      }
    }
  } catch (err) {
    return { ok: false, phase: 'stat', error: err?.message || '检查目标路径失败', path: resolved };
  }

  // 序列化
  let serialized;
  try {
    const indent = options.indent !== undefined ? options.indent : 2;
    serialized = JSON.stringify(data, null, indent) + '\n';
  } catch (err) {
    return { ok: false, phase: 'serialize', error: err?.message || 'JSON 序列化失败', path: resolved };
  }

  // 同目录唯一临时文件
  const baseName = path.basename(resolved);
  const rand = crypto.randomBytes(4).toString('hex');
  const tmpName = `.${baseName}.${process.pid}.${Date.now()}.${rand}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  // 1. 写入临时文件
  try {
    fsImpl.writeFileSync(tmpPath, serialized, 'utf8');
  } catch (err) {
    try { if (fsImpl.existsSync(tmpPath)) fsImpl.unlinkSync(tmpPath); } catch {}
    return { ok: false, phase: 'write_temp', error: err?.message || '写入临时文件失败', path: resolved };
  }

  // 2. 替换前校验（pre-verify）
  try {
    const tmpContent = fsImpl.readFileSync(tmpPath, 'utf8');
    const parsed = JSON.parse(tmpContent);
    if (typeof options.validate === 'function') {
      const valid = options.validate(parsed);
      if (!valid) {
        throw new Error('临时文件内容未通过业务校验规则');
      }
    }
  } catch (err) {
    try { if (fsImpl.existsSync(tmpPath)) fsImpl.unlinkSync(tmpPath); } catch {}
    return { ok: false, phase: 'pre_verify', error: err?.message || '临时文件校验失败', path: resolved };
  }

  // 3. 重命名替换目标文件（renameSync）
  try {
    fsImpl.renameSync(tmpPath, resolved);
  } catch (renameErr) {
    // 替换失败时保留原文件。禁止退回覆盖目标文件，也禁止先删除目标文件再重命名
    // 尝试清理临时文件，但临时文件清理的异常绝不能覆盖原始 rename 错误
    try {
      if (fsImpl.existsSync(tmpPath)) {
        fsImpl.unlinkSync(tmpPath);
      }
    } catch {
      // 故意忽略清理错误，保持 renameErr 为主错误
    }
    return { ok: false, phase: 'rename', error: renameErr?.message || '重命名替换目标文件失败', path: resolved };
  }

  // 4. 替换后校验（post-verify）
  try {
    const finalContent = fsImpl.readFileSync(resolved, 'utf8');
    const finalParsed = JSON.parse(finalContent);
    if (typeof options.validate === 'function') {
      const valid = options.validate(finalParsed);
      if (!valid) {
        throw new Error('目标文件写后校验未通过业务规则');
      }
    }
  } catch (postErr) {
    // 此时目标已被替换，明确报告 post_verify 阶段失败，不虚报回滚成功
    return { ok: false, phase: 'post_verify', error: postErr?.message || '替换后读回校验失败', path: resolved };
  }

  return {
    ok: true,
    path: resolved,
    bytesWritten: Buffer.byteLength(serialized, 'utf8')
  };
}

/**
 * 安全读取 JSON 文件（防空覆盖与损坏隔离备份）
 */
function safeReadJsonSync(targetPath, fallbackValue = null, options = {}) {
  const fsImpl = options.fs || fs;
  if (!targetPath) {
    return { ok: false, data: fallbackValue, exists: false, corrupted: false, error: '未指定目标路径' };
  }

  const resolved = path.resolve(targetPath);
  if (!fsImpl.existsSync(resolved)) {
    return { ok: true, data: fallbackValue, exists: false, corrupted: false };
  }

  let content = '';
  try {
    content = fsImpl.readFileSync(resolved, 'utf8');
  } catch (err) {
    return { ok: false, data: fallbackValue, exists: true, corrupted: false, error: err?.message || '读取文件失败' };
  }

  if (!content.trim()) {
    // 空文件属于内容损坏
    return { ok: false, data: fallbackValue, exists: true, corrupted: true, error: '文件内容为空' };
  }

  try {
    const parsed = JSON.parse(content);
    if (typeof options.validate === 'function') {
      const valid = options.validate(parsed);
      if (!valid) {
        throw new Error('数据结构未通过业务校验');
      }
    }
    return { ok: true, data: parsed, exists: true, corrupted: false };
  } catch (parseErr) {
    // 文件内容损坏
    let quarantinePath = null;
    if (options.quarantineCorrupt !== false) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        quarantinePath = resolved.replace(/\.json$/i, '') + `.corrupt.${stamp}.json`;
        fsImpl.copyFileSync(resolved, quarantinePath);
      } catch {}
    }

    // 尝试从备用文件恢复（如果有明确备份路径）
    if (options.backupPath && fsImpl.existsSync(options.backupPath)) {
      try {
        const bakContent = fsImpl.readFileSync(options.backupPath, 'utf8');
        const bakParsed = JSON.parse(bakContent);
        if (!options.validate || options.validate(bakParsed)) {
          return {
            ok: true,
            data: bakParsed,
            exists: true,
            corrupted: true,
            recoveredFromBackup: true,
            backupPath: options.backupPath,
            quarantinePath,
            error: parseErr?.message || '原始文件损坏，已从备份恢复'
          };
        }
      } catch {}
    }

    return {
      ok: false,
      data: fallbackValue,
      exists: true,
      corrupted: true,
      quarantinePath,
      error: parseErr?.message || 'JSON 解析失败'
    };
  }
}

module.exports = {
  safeWriteJsonSync,
  safeReadJsonSync
};
