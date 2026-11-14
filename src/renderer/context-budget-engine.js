(function (root) {
  'use strict';

  const DEFAULT_MIN_TOKENS = 16384;
  const DEFAULT_MAX_TOKENS = 2097152;
  const STOCK_DEFAULT_CLAMP_TOKENS = 256000;
  const DEFAULT_CONFIRM_TIMEOUT_MS = 45000;

  // 来自宿主 bundle E.Model 的已知静态枚举值（动态 PLACEHOLDER_M* 由 cascadeModelConfigs 解析）
  const STATIC_MODEL_ENUM_MAP = {
    235: 'chat_20706',
    246: 'google_gemini_2_5_pro',
    269: 'chat_23310',
    281: 'claude_4_sonnet',
    282: 'claude_4_sonnet_thinking',
    290: 'claude_4_opus',
    291: 'claude_4_opus_thinking',
    312: 'google_gemini_2_5_flash',
    313: 'google_gemini_2_5_flash_thinking',
    327: 'google_gemini_for_google_2_5_pro',
    328: 'google_gemini_nemosreef',
    329: 'google_gemini_2_5_flash_thinking_tools',
    330: 'google_gemini_2_5_flash_lite',
    331: 'google_gemini_2_5_pro_eval',
    332: 'google_gemini_2_5_flash_image_preview',
    333: 'claude_4_5_sonnet',
    334: 'claude_4_5_sonnet_thinking',
    335: 'google_gemini_computer_use_experimental',
    336: 'google_gemini_horizondawn',
    337: 'google_gemini_pureprism',
    338: 'google_gemini_gentleisland',
    339: 'google_gemini_rainsong',
    340: 'claude_4_5_haiku',
    341: 'claude_4_5_haiku_thinking',
    342: 'openai_gpt_oss_120b_medium',
    343: 'google_gemini_orionfire',
    346: 'google_jarvis_proxy',
    347: 'google_gemini_cosmicforge',
    348: 'google_gemini_riftrunner',
    349: 'google_jarvis_v4s',
    350: 'google_gemini_infinityjet',
    351: 'google_gemini_infinitybloom',
    352: 'google_gemini_riftrunner_thinking_low',
    353: 'google_gemini_riftrunner_thinking_high',
    354: 'google_gemini_example_gemax_sampler'
  };

  /**
   * 规范化 Protobuf 枚举前缀：将 "MODEL_PLACEHOLDER_M37" 与 "PLACEHOLDER_M37" 对齐
   */
  function stripModelEnumPrefix(raw) {
    if (raw === null || raw === undefined) return '';
    const s = String(raw).trim();
    if (!s) return '';
    return s.replace(/^MODEL_/i, '');
  }

  /**
   * 从通用数值编号转成 E.Model 枚举名（支持 1000+ 为 PLACEHOLDER_M{n-1000}）
   */
  function modelEnumNumberToName(num) {
    const n = Number(num);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (STATIC_MODEL_ENUM_MAP[n]) return STATIC_MODEL_ENUM_MAP[n].toUpperCase();
    if (n >= 1000 && n < 2000) return `PLACEHOLDER_M${n - 1000}`;
    return null;
  }

  /**
   * 判断 URL / RPC 方法是否为允许注入上下文预算的目标 RPC
   * 事实核对：StartCascadeRequest 不含 cascade_config，仅 SendUserCascadeMessage 携带
   */
  function isTargetBudgetRpc(urlOrProcedure) {
    if (!urlOrProcedure) return false;
    const s = String(urlOrProcedure);
    if (s.includes('StartCascade')) return false;
    return s.includes('SendUserCascadeMessage');
  }

  // =========================================================================
  // 1. Protobuf Binary Wire 编解码器（零依赖精准读写 SendUserCascadeMessageRequest）
  //    真实 Schema 核验结果：
  //    - SendUserCascadeMessageRequest: 1 = cascade_id (string), 5 = cascade_config (CascadeConfig)
  //    - CascadeConfig: 1 = planner_config (CascadePlannerConfig), 2 = checkpoint_config (CheckpointConfig)
  //    - CascadePlannerConfig: 1 = plan_model (enum), 15 = requested_model (ModelOrAlias: 1=model, 2=alias),
  //                            27 = custom_model_info_override (ModelInfo), 28 = model_name (string)
  //    - CheckpointConfig: 1 = token_threshold, 2 = is_sync, 5 = max_token_limit (uint32),
  //                        11 = max_output_tokens, 36 = context_window (string)
  // =========================================================================

  function readVarint(bytes, offset) {
    let result = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return { value: result, nextOffset: pos };
      }
      shift += 7n;
      if (shift > 70n) throw new Error('Invalid protobuf varint overflow');
    }
    throw new Error('Truncated protobuf varint');
  }

  function writeVarint(num) {
    let v = typeof num === 'bigint' ? num : BigInt(num);
    if (v < 0n) v = BigInt.asUintN(64, v);
    const out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return new Uint8Array(out);
  }

  function concatUint8Arrays(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  function encodeVarintField(fieldNumber, value) {
    const tag = writeVarint((fieldNumber << 3) | 0);
    const val = writeVarint(value);
    return concatUint8Arrays([tag, val]);
  }

  function encodeLengthDelimitedField(fieldNumber, payloadBytes) {
    const tag = writeVarint((fieldNumber << 3) | 2);
    const len = writeVarint(payloadBytes.length);
    return concatUint8Arrays([tag, len, payloadBytes]);
  }

  /**
   * 严格解析单层 Protobuf 消息字段，保留每个字段的原始完整切片（tag+value）
   */
  function parseProtoFields(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Expected Uint8Array');
    const fields = [];
    let pos = 0;
    while (pos < bytes.length) {
      const start = pos;
      const tagInfo = readVarint(bytes, pos);
      pos = tagInfo.nextOffset;
      const tagNum = Number(tagInfo.value);
      const fieldNumber = tagNum >>> 3;
      const wireType = tagNum & 0x07;
      if (fieldNumber <= 0) throw new Error(`Invalid protobuf field number: ${fieldNumber}`);

      let valueStart = pos;
      let valueEnd = pos;
      let varintValue = null;
      let sliceValue = null;

      if (wireType === 0) {
        const vInfo = readVarint(bytes, pos);
        varintValue = vInfo.value;
        pos = vInfo.nextOffset;
        valueEnd = pos;
      } else if (wireType === 1) {
        if (pos + 8 > bytes.length) throw new Error('Truncated 64-bit field');
        pos += 8;
        valueEnd = pos;
      } else if (wireType === 2) {
        const lenInfo = readVarint(bytes, pos);
        const len = Number(lenInfo.value);
        pos = lenInfo.nextOffset;
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > bytes.length) {
          throw new Error('Truncated length-delimited field');
        }
        valueStart = pos;
        sliceValue = bytes.subarray(pos, pos + len);
        pos += len;
        valueEnd = pos;
      } else if (wireType === 5) {
        if (pos + 4 > bytes.length) throw new Error('Truncated 32-bit field');
        pos += 4;
        valueEnd = pos;
      } else {
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
      }

      fields.push({
        fieldNumber,
        wireType,
        varintValue,
        bytesValue: sliceValue,
        rawField: bytes.subarray(start, valueEnd)
      });
    }
    return fields;
  }

  function decodeUtf8Strict(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) return '';
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  /**
   * 从二进制 SendUserCascadeMessageRequest 提取 cascadeId、模型标识与既有 checkpointConfig
   */
  function extractProtoSendMessageMetadata(bytes) {
    const topFields = parseProtoFields(bytes);
    let cascadeId = null;
    let planModelEnum = null;
    let requestedModelEnum = null;
    let modelName = null;
    let customModelOverrideRaw = null;
    let existingMaxTokenLimit = null;
    let existingContextWindow = null;

    for (const f of topFields) {
      if (f.fieldNumber === 1 && f.wireType === 2 && f.bytesValue) {
        try { cascadeId = decodeUtf8Strict(f.bytesValue); } catch {}
      } else if (f.fieldNumber === 5 && f.wireType === 2 && f.bytesValue) {
        const cfgFields = parseProtoFields(f.bytesValue);
        for (const cf of cfgFields) {
          if (cf.fieldNumber === 1 && cf.wireType === 2 && cf.bytesValue) {
            const plannerFields = parseProtoFields(cf.bytesValue);
            for (const pf of plannerFields) {
              if (pf.fieldNumber === 1 && pf.wireType === 0 && pf.varintValue !== null) {
                planModelEnum = Number(pf.varintValue);
              } else if (pf.fieldNumber === 15 && pf.wireType === 2 && pf.bytesValue) {
                const moaFields = parseProtoFields(pf.bytesValue);
                for (const mf of moaFields) {
                  if (mf.fieldNumber === 1 && mf.wireType === 0 && mf.varintValue !== null) {
                    requestedModelEnum = Number(mf.varintValue);
                  } else if (mf.fieldNumber === 2 && mf.wireType === 0 && mf.varintValue !== null) {
                    requestedModelEnum = Number(mf.varintValue);
                  }
                }
              } else if (pf.fieldNumber === 27 && pf.wireType === 2 && pf.bytesValue) {
                try {
                  const overrideFields = parseProtoFields(pf.bytesValue);
                  for (const ofield of overrideFields) {
                    if (ofield.wireType === 2 && ofield.bytesValue) {
                      const s = decodeUtf8Strict(ofield.bytesValue);
                      if (s && !customModelOverrideRaw) customModelOverrideRaw = s;
                    } else if (ofield.fieldNumber === 15 && ofield.wireType === 0 && ofield.varintValue !== null) {
                      if (planModelEnum === null) planModelEnum = Number(ofield.varintValue);
                    }
                  }
                } catch {}
              } else if (pf.fieldNumber === 28 && pf.wireType === 2 && pf.bytesValue) {
                try { modelName = decodeUtf8Strict(pf.bytesValue); } catch {}
              }
            }
          } else if (cf.fieldNumber === 2 && cf.wireType === 2 && cf.bytesValue) {
            const cpFields = parseProtoFields(cf.bytesValue);
            for (const cpf of cpFields) {
              if (cpf.fieldNumber === 5 && cpf.wireType === 0 && cpf.varintValue !== null) {
                existingMaxTokenLimit = Number(cpf.varintValue);
              } else if (cpf.fieldNumber === 36 && cpf.wireType === 2 && cpf.bytesValue) {
                try { existingContextWindow = decodeUtf8Strict(cpf.bytesValue); } catch {}
              }
            }
          }
        }
      }
    }

    return {
      cascadeId,
      planModelEnum,
      requestedModelEnum,
      modelName,
      customModelOverrideRaw,
      existingMaxTokenLimit,
      existingContextWindow
    };
  }

  /**
   * 无损重写二进制 SendUserCascadeMessageRequest 中的 cascade_config(5).checkpoint_config(2).max_token_limit(5)
   * @param {Uint8Array} bytes
   * @param {{ mode: 'fixed'|'dynamic'|'default', limitTokens?: number|null }} action
   */
  function rewriteProtoSendMessageCheckpointLimit(bytes, action) {
    const topFields = parseProtoFields(bytes);
    const isFixed = action?.mode === 'fixed' && Number.isSafeInteger(action?.limitTokens) && action.limitTokens > 0;

    // 重建 CheckpointConfig bytes：保留所有非 field 5 (max_token_limit) 的字段
    const buildCheckpointBytes = (existingCpBytes) => {
      const kept = [];
      if (existingCpBytes) {
        const cpFields = parseProtoFields(existingCpBytes);
        for (const cpf of cpFields) {
          if (cpf.fieldNumber === 5) continue;
          kept.push(cpf.rawField);
        }
      }
      if (isFixed) {
        kept.push(encodeVarintField(5, action.limitTokens));
      }
      if (!kept.length) return null;
      return concatUint8Arrays(kept);
    };

    // 重建 CascadeConfig bytes：保留所有非 field 2 (checkpoint_config) 的字段
    const buildCascadeConfigBytes = (existingCfgBytes) => {
      const kept = [];
      let mergedCp = null;
      if (existingCfgBytes) {
        const cfgFields = parseProtoFields(existingCfgBytes);
        for (const cf of cfgFields) {
          if (cf.fieldNumber === 2 && cf.wireType === 2 && cf.bytesValue) {
            mergedCp = mergedCp ? concatUint8Arrays([mergedCp, cf.bytesValue]) : cf.bytesValue;
            continue;
          }
          kept.push(cf.rawField);
        }
      }
      const nextCpBytes = buildCheckpointBytes(mergedCp);
      if (nextCpBytes) {
        kept.push(encodeLengthDelimitedField(2, nextCpBytes));
      }
      if (!kept.length) return null;
      return concatUint8Arrays(kept);
    };

    const outFields = [];
    let mergedCascadeCfg = null;
    for (const f of topFields) {
      if (f.fieldNumber === 5 && f.wireType === 2 && f.bytesValue) {
        mergedCascadeCfg = mergedCascadeCfg ? concatUint8Arrays([mergedCascadeCfg, f.bytesValue]) : f.bytesValue;
        continue;
      }
      outFields.push(f.rawField);
    }

    if (mergedCascadeCfg || isFixed) {
      const nextCfgBytes = buildCascadeConfigBytes(mergedCascadeCfg);
      if (nextCfgBytes) {
        outFields.push(encodeLengthDelimitedField(5, nextCfgBytes));
      }
    }

    return concatUint8Arrays(outFields);
  }

  // =========================================================================
  // 2. 多传输格式解包与回包（JSON / Lcc WebSocket JSON / 5-byte Envelope / Protobuf Binary）
  // =========================================================================

  function toUint8Array(body) {
    if (!body) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    return null;
  }

  function looksLikeJsonText(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  /**
   * 统一解包外发请求体或 WebSocket 文本帧
   * @param {any} body
   * @param {{ channel?: string, urlOrProcedure?: string, contentType?: string }} [meta]
   */
  function unpackTransportPayload(body, meta = {}) {
    if (!body) return null;
    const channel = meta.channel || 'http';
    const contentType = String(meta.contentType || '').toLowerCase();
    const urlOrProc = String(meta.urlOrProcedure || '');

    if (typeof body === 'string') {
      if (!looksLikeJsonText(body)) return null;
      let parsed = null;
      try {
        parsed = JSON.parse(body.trim());
      } catch {
        return null;
      }
      // 宿主 Lcc WebSocket JSON 封装：{ streamId, type: "start", procedure, stream, headers, payload }
      if (parsed && typeof parsed === 'object' && parsed.type === 'start' && typeof parsed.procedure === 'string' && parsed.payload && typeof parsed.payload === 'object') {
        return {
          format: 'ws_lcc_json',
          procedure: parsed.procedure,
          envelope: parsed,
          payload: parsed.payload
        };
      }
      return { format: 'json_string', payload: parsed };
    }

    const raw = toUint8Array(body);
    if (!raw || raw.length === 0) return null;

    // 优先判断是否为 5 字节 Connect / gRPC-Web Envelope：[flags(1B), uint32BE length(4B)] + body
    const expectsProtoContentType = contentType.includes('proto') || contentType.includes('grpc');
    if (raw.length >= 5) {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const flags = view.getUint8(0);
      const declaredLen = view.getUint32(1, false);
      if (raw.length === 5 + declaredLen || (raw.length > 5 + declaredLen && (flags === 0 || flags === 1 || flags === 2))) {
        if ((flags & 1) !== 0) {
          return { format: 'compressed_unsupported', flags, uninjectableReason: 'unsupported_compressed_frame' };
        }
        const inner = raw.subarray(5, 5 + declaredLen);
        let decodedText = null;
        try {
          decodedText = new TextDecoder('utf-8', { fatal: true }).decode(inner);
        } catch {}
        if (!expectsProtoContentType && decodedText && looksLikeJsonText(decodedText)) {
          try {
            return { format: 'connect_envelope', flags, payload: JSON.parse(decodedText.trim()) };
          } catch {}
        }
        try {
          const protoMeta = extractProtoSendMessageMetadata(inner);
          return { format: 'connect_proto_envelope', flags, rawInner: inner, trailing: raw.subarray(5 + declaredLen), protoMeta };
        } catch {}
      }
    }

    // 尝试纯 UTF-8 JSON 二进制体
    if (!expectsProtoContentType) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (looksLikeJsonText(text)) {
          const parsed = JSON.parse(text.trim());
          if (parsed && typeof parsed === 'object' && parsed.type === 'start' && typeof parsed.procedure === 'string' && parsed.payload) {
            return {
              format: 'ws_lcc_json_binary',
              procedure: parsed.procedure,
              envelope: parsed,
              payload: parsed.payload
            };
          }
          return { format: 'raw_binary_json', payload: parsed };
        }
      } catch {}
    }

    // 尝试原始二进制 Protobuf（仅当 URL/类型表明是目标 Protobuf RPC，避免对任意二进制误解析）
    if (expectsProtoContentType || isTargetBudgetRpc(urlOrProc)) {
      try {
        const protoMeta = extractProtoSendMessageMetadata(raw);
        return { format: 'raw_binary_proto', rawBytes: raw, protoMeta };
      } catch {
        return { format: 'unparseable_binary', uninjectableReason: 'invalid_protobuf_wire' };
      }
    }

    return null;
  }

  function packTransportPayload(unpacked, nextData) {
    if (!unpacked) return null;
    if (unpacked.format === 'json_string') {
      return JSON.stringify(nextData);
    }
    if (unpacked.format === 'ws_lcc_json') {
      return JSON.stringify({ ...unpacked.envelope, payload: nextData });
    }
    if (unpacked.format === 'ws_lcc_json_binary') {
      return new TextEncoder().encode(JSON.stringify({ ...unpacked.envelope, payload: nextData }));
    }
    if (unpacked.format === 'raw_binary_json') {
      return new TextEncoder().encode(JSON.stringify(nextData));
    }
    if (unpacked.format === 'connect_envelope') {
      const bytes = new TextEncoder().encode(JSON.stringify(nextData));
      const out = new Uint8Array(5 + bytes.length);
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint8(0, unpacked.flags || 0);
      view.setUint32(1, bytes.length, false);
      out.set(bytes, 5);
      return out;
    }
    if (unpacked.format === 'connect_proto_envelope' && nextData instanceof Uint8Array) {
      const tailLen = unpacked.trailing ? unpacked.trailing.length : 0;
      const out = new Uint8Array(5 + nextData.length + tailLen);
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint8(0, unpacked.flags || 0);
      view.setUint32(1, nextData.length, false);
      out.set(nextData, 5);
      if (tailLen > 0) out.set(unpacked.trailing, 5 + nextData.length);
      return out;
    }
    if (unpacked.format === 'raw_binary_proto' && nextData instanceof Uint8Array) {
      return nextData;
    }
    return null;
  }

  // =========================================================================
  // 2.5 模型能力参考、当前客户端运行策略解析、可调范围与统一模式逐模型预测
  // =========================================================================

  /**
   * 严格解析底座解锁/运行策略状态，将“磁盘检测模式”与“当前运行态确认状态”彻底分离
   * 绝不将 null / partial / pending_restart / runtime_unconfirmed 当作已运行的 dynamic 或 256K
   */
  function resolveRuntimeUnlockPolicy(unlockStatus) {
    if (!unlockStatus || typeof unlockStatus !== 'object') {
      return {
        policyKnown: false,
        runtimeState: 'unknown',
        diskMode: 'unknown',
        diskLimitTokens: null,
        runtimeMode: 'unknown',
        runtimeLimitTokens: null,
        currentClientLimitTokens: null,
        isDynamicUnlocked: null,
        diskVsRuntimeMismatch: false,
        status: null
      };
    }

    const status = typeof unlockStatus.status === 'string' ? unlockStatus.status : null;
    const gate3a = unlockStatus.gate3a && typeof unlockStatus.gate3a === 'object' ? unlockStatus.gate3a : null;
    const runtimeEvidence = unlockStatus.runtimeEvidence && typeof unlockStatus.runtimeEvidence === 'object'
      ? unlockStatus.runtimeEvidence
      : null;

    // 1. 解析磁盘/配置态策略（读取真实 fixed 固定值，绝不一律退化为 256,000）
    let diskMode = 'unknown';
    let diskLimitTokens = null;
    const rawConfMode = unlockStatus.configuredMode;
    const rawClampState = gate3a?.clampState || null;

    if (rawConfMode === 'dynamic' || (!rawConfMode && rawClampState === 'DYN')) {
      diskMode = 'dynamic';
    } else if (rawConfMode === 'fixed' || (!rawConfMode && rawClampState === 'CONST')) {
      const rawLim = Number(unlockStatus.configuredLimitTokens ?? gate3a?.limit);
      if (Number.isSafeInteger(rawLim) && rawLim > 0) {
        diskMode = 'fixed';
        diskLimitTokens = rawLim;
      } else {
        diskMode = 'unknown';
      }
    } else if (
      rawConfMode === 'default' ||
      (!rawConfMode && rawClampState === 'ORIG') ||
      (!rawConfMode && status === 'not_patched')
    ) {
      diskMode = 'default';
      diskLimitTokens = STOCK_DEFAULT_CLAMP_TOKENS;
    } else if (rawConfMode === 'partial' || status === 'partial_match') {
      diskMode = 'partial';
    }

    // 2. 判定运行态确认级别（磁盘修改后尚未重启、进程未确认、部分匹配、未知均不可直接冒充已运行生效）
    let runtimeState = 'unknown';
    let policyKnown = false;
    let diskVsRuntimeMismatch = false;

    if (status === 'partial_match' || diskMode === 'partial') {
      runtimeState = 'partial';
    } else if (status === 'failed' || status === 'unsupported' || diskMode === 'unknown') {
      runtimeState = 'unknown';
    } else if (status === 'patched_pending_restart' || runtimeEvidence?.restartDetected === false) {
      runtimeState = 'pending_restart';
      diskVsRuntimeMismatch = true;
    } else if (status === 'patched_runtime_unconfirmed') {
      runtimeState = 'runtime_unconfirmed';
      diskVsRuntimeMismatch = true;
    } else if (status === 'patched_loaded' || status === 'not_patched' || !status) {
      // 无否定状态且非待重启时，若传入明确策略（patched_loaded / not_patched / 或直接传入策略对象）则认定策略已知
      runtimeState = 'confirmed';
      policyKnown = true;
    }

    const runtimeMode = policyKnown ? diskMode : 'unknown';
    const runtimeLimitTokens = policyKnown ? diskLimitTokens : null;
    const currentClientLimitTokens = policyKnown && (runtimeMode === 'default' || runtimeMode === 'fixed')
      ? runtimeLimitTokens
      : null;
    const isDynamicUnlocked = policyKnown ? (runtimeMode === 'dynamic') : null;

    return {
      policyKnown,
      runtimeState,
      diskMode,
      diskLimitTokens,
      runtimeMode,
      runtimeLimitTokens,
      currentClientLimitTokens,
      isDynamicUnlocked,
      diskVsRuntimeMismatch,
      status
    };
  }

  /**
   * 从产品及其成员（含 GetAvailableModels / Step.metadata.modelInfo）汇总真实能力元数据，
   * 并严格分离：模型理论能力上限、当前客户端限制、当前策略默认预算、当前环境可采纳范围
   * 仅采信结构化字段（maxTokens / maxOutputTokens）；不做型号名字猜测或硬编码
   */
  function deriveModelCapabilitySummary(product, unlockStatus = null, modelCapabilitiesById = null) {
    const members = Array.isArray(product?.members) ? product.members : [];
    const capById = modelCapabilitiesById && typeof modelCapabilitiesById === 'object' ? modelCapabilitiesById : null;

    const findCapForMember = (m) => {
      if (!capById || !m) return null;
      const candidates = [m.modelId, m.modelOrAlias?.model, m.label]
        .filter(Boolean)
        .map(v => stripModelEnumPrefix(v).toLowerCase());
      for (const k of candidates) {
        if (k && capById[k]) return capById[k];
      }
      return null;
    };

    const tierDetails = [];
    for (const m of members) {
      const extCap = findCapForMember(m);
      const maxTokens = Number.isSafeInteger(Number(m?.maxTokens)) && Number(m.maxTokens) > 0
        ? Number(m.maxTokens)
        : (Number.isSafeInteger(Number(extCap?.maxTokens)) && Number(extCap.maxTokens) > 0 ? Number(extCap.maxTokens) : null);
      const rawOut = m?.maxOutputTokens ?? extCap?.maxOutputTokens;
      const maxOutputTokens = rawOut !== null && rawOut !== undefined && Number.isSafeInteger(Number(rawOut)) && Number(rawOut) >= 0
        ? Number(rawOut)
        : null;
      const thinkingBudget = m?.thinkingBudget ?? extCap?.thinkingBudget ?? null;
      const thinkingLevel = m?.thinkingLevel || extCap?.thinkingLevel || null;
      const capabilitySource = m?.capabilitySource || extCap?.capabilitySource || null;
      if (maxTokens !== null || maxOutputTokens !== null || thinkingLevel || thinkingBudget !== null) {
        tierDetails.push({
          modelId: m.modelId || null,
          effort: m.effort || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget,
          thinkingLevel,
          capabilitySource
        });
      }
    }

    const withWindow = tierDetails.filter(t => t.maxTokens !== null);
    const withOutput = tierDetails.filter(t => t.maxOutputTokens !== null);
    const uniqueWindows = Array.from(new Set(withWindow.map(t => t.maxTokens)));
    const uniqueOutputs = Array.from(new Set(withOutput.map(t => t.maxOutputTokens)));

    const maxTokens = uniqueWindows.length > 0 ? Math.min(...uniqueWindows) : null;
    const maxOutputTokens = uniqueOutputs.length > 0 ? Math.max(...uniqueOutputs) : null;
    const hasTierVariance = uniqueWindows.length > 1 || uniqueOutputs.length > 1;
    const sources = Array.from(new Set(tierDetails.map(t => t.capabilitySource).filter(Boolean)));

    const runtimePolicy = resolveRuntimeUnlockPolicy(unlockStatus);
    const isDynamicUnlocked = runtimePolicy.isDynamicUnlocked;
    const currentClientLimitTokens = runtimePolicy.currentClientLimitTokens;

    // 1. 模型理论能力上限与动态基准（仅依据模型结构化元数据，不受客户端状态左右）
    let modelTheoreticalMaxTokens = null;
    let dynamicDefaultBudget = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      const reserve = Math.max(maxOutputTokens, 40000);
      dynamicDefaultBudget = maxTokens > reserve ? (maxTokens - reserve) : 0;
      modelTheoreticalMaxTokens = Math.min(DEFAULT_MAX_TOKENS, maxTokens - maxOutputTokens);
    }

    // 2. 当前策略默认预算（未携带自定义 maxTokenLimit 时的当前运行态默认结果）：
    //    依据二进制核实：
    //    - utils.GetCheckpointConfig 在 default(ORIG) 下按 min(dynamicDefault, 256000) 钳位；
    //    - 在 fixed(CONST=N) 下直接改写为 N，并经 ClampCheckpointConfigForModelInfo 钳位至 <= maxTokens - maxOutputTokens；
    //    - 在 dynamic(DYN) 下采用 dynamicDefault；
    //    - 在未知 / 部分匹配 / 待重启 / 运行未确认状态下必须保持 null（不可猜测或直接套用 983040 / 256000）
    let currentStrategyDefaultBudget = null;
    if (runtimePolicy.policyKnown) {
      if (runtimePolicy.runtimeMode === 'dynamic') {
        currentStrategyDefaultBudget = dynamicDefaultBudget;
      } else if (runtimePolicy.runtimeMode === 'default') {
        currentStrategyDefaultBudget = dynamicDefaultBudget !== null
          ? Math.min(dynamicDefaultBudget, STOCK_DEFAULT_CLAMP_TOKENS)
          : null;
      } else if (runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.runtimeLimitTokens !== null) {
        const fixedVal = Math.min(DEFAULT_MAX_TOKENS, runtimePolicy.runtimeLimitTokens);
        if (modelTheoreticalMaxTokens !== null) {
          currentStrategyDefaultBudget = Math.min(fixedVal, modelTheoreticalMaxTokens);
        } else if (maxTokens !== null) {
          currentStrategyDefaultBudget = Math.min(fixedVal, maxTokens);
        } else {
          currentStrategyDefaultBudget = fixedVal;
        }
      }
    }
    const effectiveDefaultBudget = currentStrategyDefaultBudget;

    // 3. 当前环境下可确认的安全可调上限（与参考卡、最大可用按钮、预设/校验和统一预测一致）：
    //    虽然局部合并链中请求显式 maxTokenLimit 优先级高于默认基座，但未开启 Dynamic 并经实机确认前，
    //    下游覆盖与服务端策略限制仍可能将实际预算束缚于 currentClientLimitTokens
    let maxAdjustableTokens = null;
    if (runtimePolicy.policyKnown) {
      if (runtimePolicy.runtimeMode === 'dynamic') {
        maxAdjustableTokens = modelTheoreticalMaxTokens;
      } else if ((runtimePolicy.runtimeMode === 'default' || runtimePolicy.runtimeMode === 'fixed') && currentClientLimitTokens !== null) {
        const clientCap = Math.min(DEFAULT_MAX_TOKENS, currentClientLimitTokens);
        maxAdjustableTokens = modelTheoreticalMaxTokens !== null
          ? Math.min(modelTheoreticalMaxTokens, clientCap)
          : clientCap;
      }
    }

    let formulaNote = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      formulaNote = '模型理论输入上限 = maxTokens - maxOutputTokens（动态默认按 max(maxOutputTokens, 40,000) 预留）';
    } else if (maxTokens !== null && maxOutputTokens === null) {
      formulaNote = 'IDE 仅返回总窗口但缺少 maxOutputTokens，无法推导模型理论输入上限';
    }

    let policyNote = null;
    if (runtimePolicy.runtimeState === 'pending_restart') {
      policyNote = '磁盘配置已变更但运行中的客户端尚未重启，当前运行策略与可采纳上限待确认';
    } else if (runtimePolicy.runtimeState === 'runtime_unconfirmed') {
      policyNote = '仅检测到磁盘配置，尚未确认运行中进程已加载该策略';
    } else if (runtimePolicy.runtimeState === 'partial') {
      policyNote = '检测到当前环境处于部分异常状态，运行策略上限未知';
    } else if (runtimePolicy.runtimeState === 'unknown') {
      policyNote = '尚未获取或无法确认当前客户端运行策略，默认预算及目标采纳范围标为未知';
    } else if (runtimePolicy.runtimeMode === 'fixed' && currentClientLimitTokens !== null) {
      policyNote = `当前客户端运行于固定限制 ${currentClientLimitTokens.toLocaleString('en-US')} tokens`;
    } else if (runtimePolicy.runtimeMode === 'default') {
      policyNote = '当前客户端运行于默认 256,000 tokens 限制';
    } else if (runtimePolicy.runtimeMode === 'dynamic') {
      policyNote = '当前客户端已开启 Dynamic 动态跟随，按模型自身上限裁剪';
    }

    const rangeMin = maxAdjustableTokens !== null
      ? Math.min(DEFAULT_MIN_TOKENS, maxAdjustableTokens)
      : DEFAULT_MIN_TOKENS;
    const rangeMax = maxAdjustableTokens;

    return {
      productKey: product?.productKey || null,
      productLabel: product?.productLabel || null,
      maxTokens,
      maxOutputTokens,
      modelTheoreticalMaxTokens,
      dynamicDefaultBudget,
      currentClientLimitTokens,
      currentStrategyDefaultBudget,
      effectiveDefaultBudget,
      maxAdjustableTokens,
      rangeMin,
      rangeMax,
      hasMetadata: maxTokens !== null && maxOutputTokens !== null,
      hasPartialMetadata: (maxTokens !== null) !== (maxOutputTokens !== null),
      hasTierVariance,
      tierDetails,
      sources,
      runtimePolicy,
      isDynamicUnlocked,
      formulaNote,
      policyNote
    };
  }

  /**
   * 评估当前输入/预设在对应模型能力与当前客户端运行策略下的合法性及可采纳值
   * 绝不静默篡改用户数值并报成功，也不混淆模型能力上限与客户端策略上限
   */
  function evaluateLimitInput(rawVal, capSummary = null, unlockStatus = null, serviceLimit = null) {
    const rawStr = typeof rawVal === 'number' ? String(rawVal) : String(rawVal ?? '').trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(rawStr)) {
      return { ok: false, reasonCode: 'not_integer', limitTokens: null };
    }
    const num = Number(rawStr);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return { ok: false, reasonCode: 'not_integer', limitTokens: null };
    }
    if (num < DEFAULT_MIN_TOKENS || num > DEFAULT_MAX_TOKENS) {
      return {
        ok: false,
        reasonCode: 'out_of_engineering_range',
        limitTokens: num,
        min: DEFAULT_MIN_TOKENS,
        max: DEFAULT_MAX_TOKENS
      };
    }

    const warnings = [];
    const policy = arguments.length >= 3
      ? resolveRuntimeUnlockPolicy(unlockStatus)
      : (capSummary?.runtimePolicy || resolveRuntimeUnlockPolicy(null));
    const modelMaxAllowed = capSummary?.modelTheoreticalMaxTokens ?? null;
    const clientLimit = policy.policyKnown ? policy.currentClientLimitTokens : null;

    let exceedsModelLimit = false;
    const modelCapped = modelMaxAllowed !== null ? Math.min(num, modelMaxAllowed) : num;
    if (modelMaxAllowed !== null && num > modelMaxAllowed) {
      exceedsModelLimit = true;
      warnings.push({
        code: 'exceeds_model_limit',
        limitTokens: num,
        maxAllowed: modelMaxAllowed,
        adoptableTokens: policy.policyKnown && clientLimit !== null
          ? Math.min(modelCapped, clientLimit)
          : (policy.policyKnown ? modelCapped : null)
      });
    }

    let exceedsClientPolicy = false;
    let requiresDynamicUnlock = false;
    if (!policy.policyKnown) {
      warnings.push({
        code: 'unconfirmed_runtime_policy',
        limitTokens: num,
        runtimeState: policy.runtimeState,
        diskMode: policy.diskMode,
        diskLimitTokens: policy.diskLimitTokens
      });
    } else if (clientLimit !== null && num > clientLimit) {
      exceedsClientPolicy = true;
      if (policy.runtimeMode === 'default') {
        requiresDynamicUnlock = true;
        warnings.push({
          code: 'requires_dynamic_unlock',
          limitTokens: num,
          stockCap: clientLimit
        });
      } else if (policy.runtimeMode === 'fixed') {
        warnings.push({
          code: 'exceeds_fixed_client_limit',
          limitTokens: num,
          fixedCap: clientLimit
        });
      }
    }

    let adoptableTokens = null;
    if (policy.policyKnown) {
      if (policy.runtimeMode === 'dynamic') {
        adoptableTokens = modelCapped;
      } else if (clientLimit !== null) {
        adoptableTokens = Math.min(modelCapped, clientLimit);
      }
    }

    const sLimit = Number(serviceLimit || 0);
    if (sLimit > 0 && num > sLimit) {
      warnings.push({
        code: 'exceeds_service_limit',
        limitTokens: num,
        serviceLimit: sLimit
      });
    }

    if (num < 65536) {
      warnings.push({
        code: 'below_recommended_floor',
        limitTokens: num
      });
    }

    return {
      ok: true,
      limitTokens: num,
      exceedsModelLimit,
      exceedsClientPolicy,
      clientPolicyLimit: clientLimit,
      runtimeState: policy.runtimeState,
      policyKnown: policy.policyKnown,
      adoptableTokens,
      requiresDynamicUnlock,
      warnings
    };
  }

  /**
   * 统一预算模式下，为每个模型预测当前运行策略下的可采纳结果
   * 严格区分“预测值”与“运行已确认”，绝不把未知/待重启/default/fixed 错判为 exact
   */
  function projectUnifiedBudgetForProducts(unifiedPref, products = [], unlockStatus = null, modelCapabilitiesById = null) {
    const mode = unifiedPref?.mode || 'default';
    const rawLimit = mode === 'fixed' && Number.isSafeInteger(Number(unifiedPref?.limitTokens))
      ? Number(unifiedPref.limitTokens)
      : null;
    const policy = resolveRuntimeUnlockPolicy(unlockStatus);
    const unresolvedOutcome = policy.runtimeState === 'pending_restart'
      ? 'pending_restart_unconfirmed'
      : (policy.runtimeState === 'partial'
        ? 'partial_policy_unconfirmed'
        : (policy.runtimeState === 'runtime_unconfirmed' ? 'runtime_unconfirmed' : 'unknown_policy'));

    return (Array.isArray(products) ? products : []).map(prod => {
      const cap = deriveModelCapabilitySummary(prod, unlockStatus, modelCapabilitiesById);
      const modelCap = cap.modelTheoreticalMaxTokens;
      const clientCap = policy.policyKnown ? policy.currentClientLimitTokens : null;

      if (mode === 'default') {
        if (!policy.policyKnown) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: unresolvedOutcome,
            projectedTokens: null
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'client_default',
          projectedTokens: cap.effectiveDefaultBudget
        };
      }

      if (mode === 'dynamic') {
        if (!policy.policyKnown) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: unresolvedOutcome,
            projectedTokens: null
          };
        }
        if (policy.runtimeMode === 'default' || policy.runtimeMode === 'fixed') {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_by_client_policy',
            clientLimitTokens: clientCap,
            projectedTokens: cap.effectiveDefaultBudget
          };
        }
        if (cap.dynamicDefaultBudget === null) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'unknown_cap',
            projectedTokens: null
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'dynamic_follow',
          projectedTokens: cap.dynamicDefaultBudget
        };
      }

      if (!rawLimit) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'invalid_target',
          projectedTokens: null
        };
      }

      if (!policy.policyKnown) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: unresolvedOutcome,
          targetTokens: rawLimit,
          exceedsModelLimit: modelCap !== null && rawLimit > modelCap,
          projectedTokens: null
        };
      }

      if (policy.runtimeMode === 'dynamic') {
        if (modelCap === null) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'unknown_cap',
            targetTokens: rawLimit,
            projectedTokens: null
          };
        }
        if (rawLimit > modelCap) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_to_model_max',
            targetTokens: rawLimit,
            projectedTokens: modelCap
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'exact',
          targetTokens: rawLimit,
          projectedTokens: rawLimit
        };
      }

      // runtimeMode === 'default' (256,000) 或 'fixed' (N)
      if (modelCap !== null && rawLimit > modelCap) {
        if (clientCap !== null && clientCap < modelCap && rawLimit > clientCap) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_by_client_policy',
            targetTokens: rawLimit,
            clientLimitTokens: clientCap,
            modelTheoreticalMaxTokens: modelCap,
            projectedTokens: clientCap
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'clamped_to_model_max',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          projectedTokens: modelCap
        };
      }

      if (clientCap !== null && rawLimit > clientCap) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'exceeds_client_policy',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          modelTheoreticalMaxTokens: modelCap,
          projectedTokens: modelCap !== null ? Math.min(modelCap, clientCap) : clientCap
        };
      }

      if (modelCap === null) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'unknown_cap',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          projectedTokens: null
        };
      }

      return {
        productKey: prod.productKey,
        productLabel: prod.productLabel,
        vendor: prod.vendor,
        capability: cap,
        outcome: 'exact',
        targetTokens: rawLimit,
        clientLimitTokens: clientCap,
        projectedTokens: rawLimit
      };
    });
  }

  // =========================================================================
  // 3. 请求模型提取（严禁回退至插件配置面板选中项或全局历史快照）
  // =========================================================================

  function matchConfigByCandidate(candidate, knownConfigs) {
    if (!Array.isArray(knownConfigs) || !knownConfigs.length || candidate === null || candidate === undefined) {
      return null;
    }
    if (typeof candidate === 'number') {
      const byValue = knownConfigs.find(c => Number(c?.value) === candidate);
      if (byValue) return byValue;
      const enumName = modelEnumNumberToName(candidate);
      if (enumName) {
        return matchConfigByCandidate(enumName, knownConfigs);
      }
      return null;
    }
    const rawStr = String(candidate).trim();
    if (!rawStr) return null;
    const rawLower = rawStr.toLowerCase();
    const strippedLower = stripModelEnumPrefix(rawStr).toLowerCase();
    return knownConfigs.find(c => {
      const fields = [c?.modelId, c?.model, c?.modelOrAlias?.model, c?.modelOrAlias?.alias, c?.modelAlias, c?.label];
      for (const f of fields) {
        if (f === null || f === undefined) continue;
        const fl = String(f).trim().toLowerCase();
        if (!fl) continue;
        if (fl === rawLower || stripModelEnumPrefix(fl) === strippedLower) return true;
      }
      if (/^\d+$/.test(rawStr) && Number(c?.value) === Number(rawStr)) return true;
      return false;
    }) || null;
  }

  function normalizeResolvedCandidate(rawCandidate, knownConfigs, groupFn, resolveStableFn) {
    if (rawCandidate === null || rawCandidate === undefined) return null;
    const matchedCfg = matchConfigByCandidate(rawCandidate, knownConfigs);
    if (matchedCfg) {
      const mId = matchedCfg.modelId || matchedCfg.model || matchedCfg.modelOrAlias?.model || matchedCfg.label;
      const lbl = matchedCfg.label || matchedCfg.modelDisplayName || mId;
      const g = groupFn({ modelId: mId, label: lbl, modelOrAlias: matchedCfg.modelOrAlias, effort: matchedCfg.effort });
      if (g?.productKey) {
        return {
          productKey: g.productKey,
          productLabel: g.productLabel,
          modelId: (resolveStableFn ? resolveStableFn(matchedCfg, knownConfigs) : null) || String(mId || '').toLowerCase(),
          rawCandidate
        };
      }
    }

    let strVal = null;
    if (typeof rawCandidate === 'number') {
      strVal = modelEnumNumberToName(rawCandidate);
    } else if (typeof rawCandidate === 'string') {
      strVal = rawCandidate.trim();
    }
    if (!strVal) return null;

    // 去除 Protobuf enum 前缀并美化可读名称用于分组兜底
    const stripped = stripModelEnumPrefix(strVal);
    if (/^PLACEHOLDER_M\d+$/i.test(stripped)) {
      // 未能在已知目录中找到具体产品名时，按准确占位 ID 分组而不是跨模型猜测
      const g = groupFn({ modelId: stripped.toLowerCase(), label: stripped.toLowerCase() });
      return {
        productKey: g?.productKey || `product:other:${stripped.toLowerCase()}`,
        productLabel: g?.productLabel || stripped.toLowerCase(),
        modelId: stripped.toLowerCase(),
        rawCandidate
      };
    }

    const readable = stripped.includes('_') && stripped === stripped.toUpperCase()
      ? stripped.toLowerCase().replace(/_/g, '-')
      : stripped;
    const g = groupFn({ modelId: readable, label: readable });
    if (!g?.productKey) return null;
    return {
      productKey: g.productKey,
      productLabel: g.productLabel,
      modelId: (resolveStableFn ? resolveStableFn(readable, knownConfigs) : null) || readable.toLowerCase(),
      rawCandidate
    };
  }

  /**
   * 从出站请求对象 / 二进制元数据提取实际模型产品键
   * @param {object} requestOrProtoMeta
   * @param {{
   *   isProtoMeta?: boolean,
   *   knownConfigs?: Array,
   *   verifiedConversationBindings?: Record<string, { productKey: string, modelId?: string }>,
   *   groupProduct?: Function,
   *   resolveStableModelId?: Function
   * }} [options]
   */
  function resolveRequestModel(requestOrProtoMeta, options = {}) {
    if (!requestOrProtoMeta || typeof requestOrProtoMeta !== 'object') {
      return { resolved: false, reason: 'invalid_payload', cascadeId: null };
    }

    const knownConfigs = Array.isArray(options.knownConfigs) ? options.knownConfigs : [];
    const bindings = options.verifiedConversationBindings || {};
    const groupFn = typeof options.groupProduct === 'function'
      ? options.groupProduct
      : (input) => {
        const s = String(input?.label || input?.modelId || 'unknown').trim();
        const low = s.toLowerCase().replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
        return { productKey: `product:other:${low || 'unknown'}`, productLabel: s, vendor: '其他', effort: null };
      };
    const resolveStableFn = typeof options.resolveStableModelId === 'function' ? options.resolveStableModelId : null;

    if (options.isProtoMeta) {
      const cascadeId = requestOrProtoMeta.cascadeId || null;
      const candidates = [
        { source: 'customModelInfoOverride', value: requestOrProtoMeta.customModelOverrideRaw },
        { source: 'modelName', value: requestOrProtoMeta.modelName },
        { source: 'requestedModel', value: requestOrProtoMeta.requestedModelEnum },
        { source: 'planModel', value: requestOrProtoMeta.planModelEnum }
      ];
      for (const c of candidates) {
        if (c.value === null || c.value === undefined || c.value === 0 || c.value === '') continue;
        const norm = normalizeResolvedCandidate(c.value, knownConfigs, groupFn, resolveStableFn);
        if (norm) return { resolved: true, source: `proto_${c.source}`, cascadeId, ...norm };
      }
      if (cascadeId && bindings[cascadeId]?.productKey) {
        return {
          resolved: true,
          source: 'verified_conversation_binding',
          cascadeId,
          productKey: bindings[cascadeId].productKey,
          productLabel: bindings[cascadeId].productLabel || bindings[cascadeId].productKey,
          modelId: bindings[cascadeId].modelId || bindings[cascadeId].productKey
        };
      }
      return { resolved: false, reason: 'unidentifiable_request_model', cascadeId };
    }

    const payload = requestOrProtoMeta;
    const cascadeId = payload.cascadeId || payload.cascade_id || null;
    const cfg = payload.cascadeConfig || payload.cascade_config || {};
    const planner = cfg.plannerConfig || cfg.planner_config || payload.plannerConfig || payload.planner_config || {};

    const override = planner.customModelInfoOverride || planner.custom_model_info_override || {};
    const reqModelObj = planner.requestedModel || planner.requested_model || {};
    const candidates = [
      { source: 'customModelInfoOverride', value: override.model || override.modelId || override.label },
      { source: 'modelName', value: planner.modelName || planner.model_name },
      { source: 'requestedModel', value: reqModelObj.model || reqModelObj.alias || (reqModelObj.choice?.case ? reqModelObj.choice.value : null) },
      { source: 'planModel', value: planner.planModel ?? planner.plan_model }
    ];

    for (const c of candidates) {
      if (c.value === null || c.value === undefined || c.value === 0 || c.value === '') continue;
      const norm = normalizeResolvedCandidate(c.value, knownConfigs, groupFn, resolveStableFn);
      if (norm) return { resolved: true, source: c.source, cascadeId, ...norm };
    }

    if (cascadeId && bindings[cascadeId]?.productKey) {
      return {
        resolved: true,
        source: 'verified_conversation_binding',
        cascadeId,
        productKey: bindings[cascadeId].productKey,
        productLabel: bindings[cascadeId].productLabel || bindings[cascadeId].productKey,
        modelId: bindings[cascadeId].modelId || bindings[cascadeId].productKey
      };
    }

    return { resolved: false, reason: 'unidentifiable_request_model', cascadeId };
  }

  // =========================================================================
  // 4. 预算偏好查询与请求篡改（支持对象/JSON/Protobuf、保护 $typeName 与默认清理）
  // =========================================================================

  function findPreferenceForProduct(productKey, contextPreferencesMap) {
    if (!productKey || !contextPreferencesMap || typeof contextPreferencesMap !== 'object') return null;
    if (contextPreferencesMap[productKey]) return contextPreferencesMap[productKey];
    const pSlug = String(productKey).replace(/^product:[^:]+:/, '').toLowerCase();
    for (const [k, pref] of Object.entries(contextPreferencesMap)) {
      if (!pref) continue;
      const kSlug = String(k).replace(/^product:[^:]+:/, '').toLowerCase();
      if (kSlug && kSlug === pSlug) return pref;
    }
    return null;
  }

  function resolveBudgetPolicy(options = {}) {
    const scopeMode = options.scopeMode === 'per_model' ? 'per_model' : 'unified';
    const pref = scopeMode === 'unified'
      ? (options.unifiedPreference || { mode: 'default', limitTokens: null })
      : findPreferenceForProduct(options.productKey, options.contextPreferencesMap);
    if (!pref) {
      return { mode: 'default', limitTokens: null, hasExplicitPref: false };
    }
    const mode = pref.mode === 'fixed' || pref.mode === 'dynamic' ? pref.mode : 'default';
    if (mode === 'fixed') {
      const limit = Number(pref.limitTokens);
      const minTokens = Number(options.minTokens || DEFAULT_MIN_TOKENS);
      const maxTokens = Number(options.maxTokens || DEFAULT_MAX_TOKENS);
      if (Number.isSafeInteger(limit) && limit >= minTokens && limit <= maxTokens) {
        return { mode: 'fixed', limitTokens: limit, hasExplicitPref: true };
      }
      return { mode: 'invalid_fixed', limitTokens: limit, hasExplicitPref: true };
    }
    return { mode, limitTokens: null, hasExplicitPref: true };
  }

  /**
   * 在 JS 请求对象上注入/清理 CheckpointConfig.maxTokenLimit（支持 Snake/Camel 单套与 @bufbuild/protobuf v2 $typeName）
   */
  function applyBudgetPolicyToObject(payload, policy) {
    if (!payload || typeof payload !== 'object' || !policy) {
      return { modified: false, appliedMode: 'passthrough', sentLimitTokens: null };
    }

    const usesProtoBufTypeName = Boolean(
      payload.$typeName
      || payload.cascadeConfig?.$typeName
      || payload.cascadeConfig?.plannerConfig?.$typeName
      || payload.cascadeConfig?.checkpointConfig?.$typeName
    );
    const isSnake = Boolean(payload.cascade_config && !payload.cascadeConfig);

    if (policy.mode === 'fixed' && Number.isSafeInteger(policy.limitTokens)) {
      if (isSnake) {
        payload.cascade_config = payload.cascade_config || {};
        payload.cascade_config.checkpoint_config = payload.cascade_config.checkpoint_config || {};
        payload.cascade_config.checkpoint_config.max_token_limit = policy.limitTokens;
      } else {
        if (!payload.cascadeConfig) {
          payload.cascadeConfig = usesProtoBufTypeName ? { $typeName: 'exa.cortex_pb.CascadeConfig' } : {};
        }
        if (!payload.cascadeConfig.checkpointConfig) {
          payload.cascadeConfig.checkpointConfig = usesProtoBufTypeName ? { $typeName: 'exa.cortex_pb.CheckpointConfig' } : {};
        } else if (usesProtoBufTypeName && !payload.cascadeConfig.checkpointConfig.$typeName) {
          payload.cascadeConfig.checkpointConfig.$typeName = 'exa.cortex_pb.CheckpointConfig';
        }
        payload.cascadeConfig.checkpointConfig.maxTokenLimit = policy.limitTokens;
      }
      return { modified: true, appliedMode: 'fixed', sentLimitTokens: policy.limitTokens };
    }

    // dynamic 或 default：必须清除任何残留固定阈值，绝不保留上一次遗留的 fixed 值
    let cleared = false;
    if (payload.cascadeConfig?.checkpointConfig && payload.cascadeConfig.checkpointConfig.maxTokenLimit !== undefined) {
      delete payload.cascadeConfig.checkpointConfig.maxTokenLimit;
      cleared = true;
    }
    if (payload.cascade_config?.checkpoint_config && payload.cascade_config.checkpoint_config.max_token_limit !== undefined) {
      delete payload.cascade_config.checkpoint_config.max_token_limit;
      cleared = true;
    }
    return {
      modified: cleared,
      appliedMode: policy.mode === 'dynamic' ? 'dynamic' : 'default',
      sentLimitTokens: null
    };
  }

  /**
   * 一体化拦截变换（支持 client_object / HTTP JSON / WebSocket Lcc / Envelope / Protobuf Binary）
   */
  function transformOutgoingSendRequest(input, context = {}) {
    const channel = context.channel || 'http';
    const urlOrProcedure = context.urlOrProcedure || '';

    // 1. 先检查 RPC 通道目标
    if (channel !== 'ws_frame' && urlOrProcedure && !isTargetBudgetRpc(urlOrProcedure)) {
      return { handled: false, passthrough: true, reason: 'non_target_rpc' };
    }

    // 2. 如果是客户端装饰器直传对象
    if (channel === 'client_object') {
      if (!input || typeof input !== 'object') {
        return { handled: false, passthrough: true, reason: 'invalid_client_request' };
      }
      const resolved = resolveRequestModel(input, context);
      const scopeMode = context.scopeMode === 'per_model' ? 'per_model' : 'unified';
      if (!resolved.resolved && scopeMode !== 'unified') {
        return {
          handled: true,
          passthrough: true,
          modified: false,
          uninjectable: true,
          reason: resolved.reason || 'unidentifiable_request_model',
          cascadeId: resolved.cascadeId || null,
          productKey: null
        };
      }
      const policy = resolveBudgetPolicy({
        scopeMode,
        unifiedPreference: context.unifiedPreference,
        contextPreferencesMap: context.contextPreferencesMap,
        productKey: resolved.productKey,
        minTokens: context.minTokens,
        maxTokens: context.maxTokens
      });
      if (policy.mode === 'invalid_fixed') {
        return {
          handled: true,
          passthrough: true,
          modified: false,
          uninjectable: true,
          reason: 'invalid_fixed_limit',
          cascadeId: resolved.cascadeId || null,
          productKey: resolved.productKey || null
        };
      }
      const applied = applyBudgetPolicyToObject(input, policy);
      return {
        handled: true,
        passthrough: policy.mode === 'default' && !applied.modified,
        modified: applied.modified,
        uninjectable: false,
        channel,
        cascadeId: resolved.cascadeId || input.cascadeId || input.cascade_id || null,
        productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
        productLabel: resolved.productLabel || null,
        modelId: resolved.modelId || null,
        modelSource: resolved.source || null,
        scopeMode,
        targetMode: policy.mode,
        targetLimitTokens: policy.limitTokens,
        sentMode: applied.appliedMode,
        sentLimitTokens: applied.sentLimitTokens,
        output: input
      };
    }

    // 3. 传输层帧/请求体（WebSocket / Fetch / XHR）
    const unpacked = unpackTransportPayload(input, { channel, urlOrProcedure, contentType: context.contentType });
    if (!unpacked) {
      return { handled: false, passthrough: true, reason: 'unrecognized_body' };
    }

    // WebSocket Lcc 帧需在解包后检验 procedure
    if (channel === 'ws_frame') {
      if (!unpacked.procedure || !isTargetBudgetRpc(unpacked.procedure)) {
        return { handled: false, passthrough: true, reason: 'non_target_ws_procedure' };
      }
    }

    if (unpacked.uninjectableReason) {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: unpacked.uninjectableReason,
        channel,
        cascadeId: null,
        productKey: null
      };
    }

    const isProto = unpacked.format === 'connect_proto_envelope' || unpacked.format === 'raw_binary_proto';
    const resolved = isProto
      ? resolveRequestModel(unpacked.protoMeta, { ...context, isProtoMeta: true })
      : resolveRequestModel(unpacked.payload, { ...context, isProtoMeta: false });

    const scopeMode = context.scopeMode === 'per_model' ? 'per_model' : 'unified';
    if (!resolved.resolved && scopeMode !== 'unified') {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: resolved.reason || 'unidentifiable_request_model',
        channel,
        cascadeId: resolved.cascadeId || null,
        productKey: null
      };
    }

    const policy = resolveBudgetPolicy({
      scopeMode,
      unifiedPreference: context.unifiedPreference,
      contextPreferencesMap: context.contextPreferencesMap,
      productKey: resolved.productKey,
      minTokens: context.minTokens,
      maxTokens: context.maxTokens
    });
    if (policy.mode === 'invalid_fixed') {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: 'invalid_fixed_limit',
        channel,
        cascadeId: resolved.cascadeId || null,
        productKey: resolved.productKey || null
      };
    }

    if (isProto) {
      const srcBytes = unpacked.format === 'connect_proto_envelope' ? unpacked.rawInner : unpacked.rawBytes;
      const hadExisting = unpacked.protoMeta?.existingMaxTokenLimit !== null && unpacked.protoMeta?.existingMaxTokenLimit !== undefined;
      let nextProtoBytes = srcBytes;
      let modified = false;
      if (policy.mode === 'fixed') {
        nextProtoBytes = rewriteProtoSendMessageCheckpointLimit(srcBytes, { mode: 'fixed', limitTokens: policy.limitTokens });
        modified = true;
      } else if (hadExisting) {
        nextProtoBytes = rewriteProtoSendMessageCheckpointLimit(srcBytes, { mode: policy.mode, limitTokens: null });
        modified = true;
      }
      const packed = modified ? packTransportPayload(unpacked, nextProtoBytes) : input;
      return {
        handled: true,
        passthrough: !modified,
        modified,
        uninjectable: false,
        channel,
        format: unpacked.format,
        cascadeId: resolved.cascadeId || null,
        productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
        productLabel: resolved.productLabel || null,
        modelId: resolved.modelId || null,
        modelSource: resolved.source || null,
        scopeMode,
        targetMode: policy.mode,
        targetLimitTokens: policy.limitTokens,
        sentMode: policy.mode === 'fixed' ? 'fixed' : (policy.mode === 'dynamic' ? 'dynamic' : 'default'),
        sentLimitTokens: policy.mode === 'fixed' ? policy.limitTokens : null,
        output: packed || input
      };
    }

    const applied = applyBudgetPolicyToObject(unpacked.payload, policy);
    const packed = applied.modified ? packTransportPayload(unpacked, unpacked.payload) : input;
    return {
      handled: true,
      passthrough: !applied.modified,
      modified: Boolean(applied.modified && packed),
      uninjectable: false,
      channel,
      format: unpacked.format,
      cascadeId: resolved.cascadeId || unpacked.payload?.cascadeId || unpacked.payload?.cascade_id || null,
      productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
      productLabel: resolved.productLabel || null,
      modelId: resolved.modelId || null,
      modelSource: resolved.source || null,
      scopeMode,
      targetMode: policy.mode,
      targetLimitTokens: policy.limitTokens,
      sentMode: applied.appliedMode,
      sentLimitTokens: applied.sentLimitTokens,
      output: packed || input
    };
  }

  // =========================================================================
  // 5. 发送追踪、因果观测与严格状态机 (杜绝时间戳造假与假确认)
  // =========================================================================

  function makeScopeKey(convoId, productKey) {
    return `${convoId || '__no_conv__'}::${productKey || '__no_product__'}`;
  }

  function createContextBudgetTracker(options = {}) {
    const confirmTimeoutMs = Number(options.confirmTimeoutMs || DEFAULT_CONFIRM_TIMEOUT_MS);
    const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
    let seqCounter = 0;

    // 按 (convoId, productKey) 隔离保存最近发送记录，防止并发会话/快速切换互相覆盖
    const dispatchesByScope = new Map();
    const dispatchesById = new Map();
    // 仅在无活跃会话上下文时辅助查询按产品的最近发送，不跨会话冒用确认
    const dispatchesByProduct = new Map();
    // 按 (convoId, productKey) 隔离保存真实观测快照
    const observationsByScope = new Map();
    // 已验证的会话->模型绑定（仅来自明确请求的响应或该会话真实 metadata）
    const verifiedConversationBindings = Object.create(null);

    function recordConversationBinding(convoId, binding) {
      if (!convoId || !binding?.productKey) return;
      verifiedConversationBindings[convoId] = {
        productKey: binding.productKey,
        productLabel: binding.productLabel || binding.productKey,
        modelId: binding.modelId || binding.productKey,
        updatedAt: nowFn()
      };
    }

    function getBaselineForScope(convoId, productKey) {
      const obs = observationsByScope.get(makeScopeKey(convoId, productKey));
      if (!obs) return { callId: null, stepCount: -1, obsTs: 0 };
      return {
        callId: obs.callId || null,
        stepCount: Number.isFinite(obs.stepCount) ? obs.stepCount : -1,
        obsTs: Number(obs.ts || 0)
      };
    }

    function beginDispatch(info = {}) {
      const seq = ++seqCounter;
      const timestamp = Number(info.timestamp || nowFn());
      const convoId = info.cascadeId || info.convoId || null;
      const productKey = info.productKey || null;
      const dispatchId = `disp_${seq}_${timestamp}`;

      if (convoId && productKey && productKey !== '__unified__') {
        recordConversationBinding(convoId, {
          productKey,
          productLabel: info.productLabel,
          modelId: info.modelId
        });
      }

      const baseline = getBaselineForScope(convoId, productKey);
      // 严禁在诊断追踪中落盘任何用户对话内容或凭证信息，仅保留结构化预算追踪字段
      const sanitizedPrefSnapshot = info.prefSnapshot && typeof info.prefSnapshot === 'object'
        ? {
          mode: info.prefSnapshot.mode || 'default',
          limitTokens: info.prefSnapshot.mode === 'fixed' && Number.isSafeInteger(Number(info.prefSnapshot.limitTokens))
            ? Number(info.prefSnapshot.limitTokens)
            : null
        }
        : {
          mode: info.targetMode || 'default',
          limitTokens: info.targetLimitTokens ?? null
        };
      const record = {
        dispatchId,
        seq,
        cascadeId: convoId,
        convoId,
        productKey,
        modelId: info.modelId || null,
        scopeMode: info.scopeMode || 'per_model',
        prefSnapshot: sanitizedPrefSnapshot,
        targetMode: info.targetMode || 'default',
        targetLimitTokens: info.targetLimitTokens ?? null,
        sentMode: info.sentMode || info.targetMode || 'default',
        sentLimitTokens: info.sentLimitTokens ?? null,
        channel: info.channel || 'http',
        transport: info.channel || 'http',
        status: info.status || 'dispatched',
        errorMessage: info.errorMessage ? String(info.errorMessage).slice(0, 160) : null,
        reason: info.reason || null,
        baselineCallId: baseline.callId,
        baselineStepCount: baseline.stepCount,
        baselineObsTs: baseline.obsTs,
        timestamp
      };

      const sKey = makeScopeKey(convoId, productKey);
      dispatchesByScope.set(sKey, record);
      dispatchesById.set(dispatchId, record);
      if (dispatchesById.size > 200) {
        const oldestKey = dispatchesById.keys().next().value;
        if (oldestKey) dispatchesById.delete(oldestKey);
      }
      if (productKey && productKey !== '__unified__') {
        dispatchesByProduct.set(productKey, record);
      }
      return record;
    }

    function updateDispatchStatus(dispatchId, patch = {}) {
      const rec = dispatchesById.get(dispatchId);
      if (!rec) return null;
      Object.assign(rec, patch);
      return rec;
    }

    /**
     * 记录后端真实观测，绝不在旧快照上用 Date.now() 刷新 ts
     */
    function recordObservation(obsInput = {}) {
      const convoId = obsInput.convoId || obsInput.cascadeId || null;
      const productKey = obsInput.productKey || null;
      if (!productKey) return null;

      const sKey = makeScopeKey(convoId, productKey);
      const prev = observationsByScope.get(sKey);
      const budget = Number(obsInput.budget || 0);
      const serviceLimit = Number(obsInput.serviceLimit || 0);
      const modelHardLimit = Number(obsInput.modelHardLimit || 0);
      const callId = obsInput.callId || null;
      const stepCount = Number.isFinite(Number(obsInput.stepCount)) ? Number(obsInput.stepCount) : -1;
      const explicitTs = Number(obsInput.ts || 0);

      // 判定是否为“新步骤 / 新响应”，而非同一快照反复轮询（绝不因 poll 时间戳增加而推进旧快照 ts）
      const sameCall = callId ? prev?.callId === callId : prev?.callId === null;
      const sameStep = stepCount === prev?.stepCount;
      const downgradedMissingCall = Boolean(
        prev &&
        !callId &&
        prev.callId &&
        (stepCount < 0 || prev.stepCount < 0 || stepCount <= prev.stepCount)
      );
      const isSameSnapshot = Boolean(
        prev &&
        prev.budget === budget &&
        prev.serviceLimit === serviceLimit &&
        prev.modelHardLimit === modelHardLimit &&
        (
          (sameCall && sameStep && (!explicitTs || callId !== null || stepCount >= 0 || explicitTs <= prev.ts)) ||
          downgradedMissingCall
        )
      );

      if (isSameSnapshot) {
        return prev;
      }

      const nextTs = explicitTs > 0 ? explicitTs : nowFn();
      const next = {
        convoId,
        productKey,
        modelId: obsInput.modelId || prev?.modelId || null,
        modelLabel: obsInput.modelLabel || prev?.modelLabel || null,
        effort: obsInput.effort || prev?.effort || null,
        budget,
        serviceLimit,
        modelHardLimit,
        callId,
        stepCount,
        ts: nextTs
      };
      observationsByScope.set(sKey, next);

      if (convoId && productKey !== '__unified__') {
        recordConversationBinding(convoId, {
          productKey,
          productLabel: next.modelLabel,
          modelId: next.modelId
        });
      }
      return next;
    }

    function getScopedObservation(convoId, productKey) {
      if (!productKey) return null;
      if (convoId) {
        return observationsByScope.get(makeScopeKey(convoId, productKey)) || null;
      }
      // 无活跃会话时不臆测，可按最新 matching scope 返回但标注 convoId
      let latest = null;
      for (const obs of observationsByScope.values()) {
        if (obs.productKey === productKey && (!latest || obs.ts > latest.ts)) {
          latest = obs;
        }
      }
      return latest;
    }

    function getScopedDispatch(convoId, productKey, scopeMode = 'per_model') {
      if (convoId) {
        const direct = dispatchesByScope.get(makeScopeKey(convoId, productKey));
        if (direct) return direct;
        if (scopeMode === 'unified') {
          const unifiedRec = dispatchesByScope.get(makeScopeKey(convoId, '__unified__'));
          if (unifiedRec) return unifiedRec;
        }
        return null;
      }
      if (productKey && dispatchesByProduct.has(productKey)) {
        return dispatchesByProduct.get(productKey);
      }
      return null;
    }

    function isPostDispatchObservation(dispatch, obs) {
      if (!dispatch || !obs) return false;
      if (dispatch.convoId && obs.convoId && dispatch.convoId !== obs.convoId) return false;
      if (obs.ts < dispatch.timestamp) return false;
      const changedCall = Boolean(obs.callId && obs.callId !== dispatch.baselineCallId);
      const advancedStep = obs.stepCount >= 0 && obs.stepCount > dispatch.baselineStepCount;
      if (changedCall || advancedStep) return true;
      // 若 callId 与发送前基线完全相同且步骤未增长，说明仍是旧快照（即便 scannedAt/ts 更新也绝非新响应）
      if (obs.callId && dispatch.baselineCallId && obs.callId === dispatch.baselineCallId) {
        return false;
      }
      // 若双方均有明确步数基线且未前进，同样禁止仅靠轮询时间戳伪确认
      if (dispatch.baselineStepCount >= 0 && obs.stepCount >= 0 && obs.stepCount <= dispatch.baselineStepCount) {
        return false;
      }
      return obs.ts > dispatch.baselineObsTs;
    }

    function evaluateStatus(params = {}) {
      const product = params.product || null;
      const scopeMode = params.scopeMode === 'per_model' ? 'per_model' : 'unified';
      const activePref = params.pref || { mode: 'default', limitTokens: null };
      const activeConvId = params.activeConvId || null;
      const now = Number(params.now || nowFn());

      if (!product) {
        return {
          status: 'unconfirmed',
          convoId: activeConvId || '—',
          targetMode: activePref?.mode || 'default',
          targetLimit: activePref?.mode === 'fixed' ? Number(activePref?.limitTokens) : null,
          dispatched: null,
          observation: null,
          diagnosisCode: 'missing_product'
        };
      }

      const targetMode = activePref?.mode || 'default';
      const targetLimit = targetMode === 'fixed' && Number.isSafeInteger(Number(activePref?.limitTokens))
        ? Number(activePref.limitTokens)
        : null;

      const rawDispatched = getScopedDispatch(activeConvId, product.productKey, scopeMode);
      const obs = getScopedObservation(activeConvId || rawDispatched?.convoId || null, product.productKey);
      const obsBudget = Number(obs?.budget || 0);
      const serviceLimit = Number(obs?.serviceLimit || 0);
      const modelHardLimit = Number(params.modelHardLimit || obs?.modelHardLimit || 0);

      // 先校验最近发送记录是否匹配“当前保存的新目标”（含从固定改默认、从失败目标改新值），不匹配则不误报旧结果
      const matchesCurrentTarget = Boolean(
        rawDispatched &&
        rawDispatched.targetMode === targetMode &&
        (targetMode !== 'fixed' || rawDispatched.targetLimitTokens === targetLimit)
      );
      const dispatched = matchesCurrentTarget ? rawDispatched : null;
      const effectiveConvoId = dispatched?.convoId || obs?.convoId || activeConvId || '—';

      if (!dispatched) {
        if (targetMode === 'default') {
          return {
            status: 'default',
            convoId: effectiveConvoId,
            targetMode,
            targetLimit: null,
            dispatched: null,
            observation: obs,
            diagnosisCode: 'default_pending_dispatch'
          };
        }
        return {
          status: 'saved_pending_dispatch',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched: null,
          observation: obs,
          diagnosisCode: 'awaiting_next_send'
        };
      }

      if (dispatched.status === 'send_failed') {
        return {
          status: 'send_failed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'dispatch_failed',
          errorMessage: dispatched.errorMessage || '请求发送失败'
        };
      }
      if (dispatched.status === 'aborted') {
        return {
          status: 'aborted',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'dispatch_aborted'
        };
      }
      if (dispatched.status === 'uninjectable') {
        return {
          status: 'uninjectable',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: dispatched.reason || 'uninjectable'
        };
      }

      const hasPostObs = isPostDispatchObservation(dispatched, obs);
      if (!hasPostObs || obsBudget <= 0) {
        if (now - dispatched.timestamp > confirmTimeoutMs) {
          return {
            status: 'timeout_unconfirmed',
            convoId: effectiveConvoId,
            targetMode,
            targetLimit,
            dispatched,
            observation: obs,
            diagnosisCode: 'confirm_timeout'
          };
        }
        return {
          status: 'dispatched_pending_confirm',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'awaiting_backend_obs'
        };
      }

      if (targetMode === 'default') {
        return {
          status: 'default',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit: null,
          dispatched,
          observation: obs,
          diagnosisCode: 'default_confirmed'
        };
      }

      if (targetMode === 'dynamic') {
        return {
          status: 'confirmed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit: null,
          dispatched,
          observation: obs,
          diagnosisCode: 'dynamic_observed'
        };
      }

      // 精确整数比对，不随便放宽到 ±5% 或 ±64 掩盖差值
      if (obsBudget === targetLimit) {
        return {
          status: 'confirmed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'exact_match'
        };
      }

      // 仅当存在明确的服务端或 ModelInfo 硬上限证据且目标超出该上限时，才判定为受模型上限限制
      const knownCap = (serviceLimit > 0 ? serviceLimit : 0) || (modelHardLimit > 0 ? modelHardLimit : 0);
      if (knownCap > 0 && targetLimit > knownCap && obsBudget <= knownCap) {
        return {
          status: 'clamped_by_model_limit',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          knownCap,
          dispatched,
          observation: obs,
          diagnosisCode: 'server_or_model_cap'
        };
      }

      return {
        status: 'mismatch',
        convoId: effectiveConvoId,
        targetMode,
        targetLimit,
        dispatched,
        observation: obs,
        diagnosisCode: 'budget_mismatch_unknown_reason'
      };
    }

    function clearConversation(convoId) {
      if (!convoId) return;
      for (const k of Array.from(dispatchesByScope.keys())) {
        if (k.startsWith(`${convoId}::`)) dispatchesByScope.delete(k);
      }
      for (const k of Array.from(observationsByScope.keys())) {
        if (k.startsWith(`${convoId}::`)) observationsByScope.delete(k);
      }
      delete verifiedConversationBindings[convoId];
    }

    function exportAllObservationsByProduct() {
      const out = {};
      for (const obs of observationsByScope.values()) {
        if (!obs.productKey) continue;
        const prev = out[obs.productKey];
        if (!prev || obs.ts > prev.ts) out[obs.productKey] = obs;
      }
      return out;
    }

    function exportDiagnosticTraces() {
      return Array.from(dispatchesById.values()).map(rec => {
        const obs = getScopedObservation(rec.convoId, rec.productKey);
        const postMatched = obs && isPostDispatchObservation(rec, obs);
        return {
          dispatchSeq: rec.seq,
          dispatchId: rec.dispatchId,
          convoId: rec.convoId || null,
          productKey: rec.productKey || null,
          modelId: rec.modelId || null,
          scopeMode: rec.scopeMode,
          prefSnapshot: rec.prefSnapshot || null,
          sentMode: rec.sentMode,
          sentLimitTokens: rec.sentLimitTokens,
          transport: rec.transport || rec.channel || null,
          status: rec.status,
          observedBudget: postMatched ? (obs.budget || null) : null,
          observedAt: postMatched ? (obs.ts || null) : null,
          timestamp: rec.timestamp
        };
      });
    }

    return {
      beginDispatch,
      updateDispatchStatus,
      recordObservation,
      recordConversationBinding,
      getScopedDispatch,
      getScopedObservation,
      evaluateStatus,
      clearConversation,
      exportAllObservationsByProduct,
      exportDiagnosticTraces,
      verifiedConversationBindings
    };
  }

  const api = {
    DEFAULT_MIN_TOKENS,
    DEFAULT_MAX_TOKENS,
    STOCK_DEFAULT_CLAMP_TOKENS,
    DEFAULT_CONFIRM_TIMEOUT_MS,
    STATIC_MODEL_ENUM_MAP,
    stripModelEnumPrefix,
    modelEnumNumberToName,
    isTargetBudgetRpc,
    readVarint,
    writeVarint,
    encodeVarintField,
    encodeLengthDelimitedField,
    parseProtoFields,
    extractProtoSendMessageMetadata,
    rewriteProtoSendMessageCheckpointLimit,
    unpackTransportPayload,
    packTransportPayload,
    resolveRuntimeUnlockPolicy,
    deriveModelCapabilitySummary,
    evaluateLimitInput,
    projectUnifiedBudgetForProducts,
    resolveRequestModel,
    findPreferenceForProduct,
    resolveBudgetPolicy,
    applyBudgetPolicyToObject,
    transformOutgoingSendRequest,
    createContextBudgetTracker
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.__AGContextBudgetEngine = api;
  }
})(globalThis);
