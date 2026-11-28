  var cumLockedKey = null;
  var cumHoveredKey = null;
  var cumExpandedWeekKey = null;
  var cumLinkedDailyDate = null;
  var _lastCumSummary = null;

  function resetCumSelectionState() {
    cumLockedKey = null;
    cumHoveredKey = null;
    cumExpandedWeekKey = null;
    cumLinkedDailyDate = null;
  }

  function hasActiveCumLock() {
    return Boolean(cumLockedKey);
  }

  function clearCumLockAndRefresh() {
    if (!cumLockedKey) return false;
    cumLockedKey = null;
    cumExpandedWeekKey = null;
    cumLinkedDailyDate = null;
    if (typeof hidePopover === 'function') hidePopover();
    if (activeHeatView === 'cum') renderHeatmapCum();
    return true;
  }

  function formatCumShortDate(ymd) {
    const parts = String(ymd || '').split('-');
    if (parts.length !== 3) return String(ymd || '');
    return `${parts[1]}.${parts[2]}`;
  }

  function locateDayInDailyHeatmap(ymd) {
    if (!ymd) return;
    cumLinkedDailyDate = ymd;
    switchHeatView('daily');
    const colsBox = el('h-grid-cols');
    if (colsBox) {
      const cells = [];
      for (const col of Array.from(colsBox.children || [])) {
        for (const c of Array.from(col.children || [])) {
          if (c.getAttribute?.('data-date') === ymd) cells.push(c);
        }
      }
      if (cells.length === 0 && typeof heatPageOffset !== 'undefined') {
        // 如果目标日因旧分页偏移不在当前页，回到最新页或定位并重绘
        heatPageOffset = 0;
        renderHeatmapGrid(true);
      }
      const targetCell = (Array.from(colsBox.children || [])
        .flatMap(col => Array.from(col.children || []))
        .find(c => c.getAttribute?.('data-date') === ymd));
      if (targetCell) {
        targetCell.scrollIntoView?.({ inline: 'center', block: 'nearest' });
        targetCell.click?.();
      }
    }
  }

  function renderHeatmapGrid(forceRebuild = false) {
    const colsBox = el('h-grid-cols');
    const monthsBox = el('h-months');
    if (!colsBox || !monthsBox) return;
    const win = computeTimelineWindow();
    const csiSelDate = (typeof state !== 'undefined' && state?.csiSelectedDate) ? state.csiSelectedDate : '';
    const sig = `${win.firstStr}:${formatLocalYmd(win.winStart)}:${Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length}:${cumLinkedDailyDate || ''}:${csiSelDate}:${typeof currentPanelLanguage !== 'undefined' ? currentPanelLanguage : ''}:${typeof activeCostModel !== 'undefined' ? activeCostModel : ''}:${typeof activeCostMode !== 'undefined' ? activeCostMode : ''}`;
    if (!forceRebuild && colsBox.children.length === 52 && colsBox.getAttribute('data-sig') === sig) return;

    monthsBox.replaceChildren();
    colsBox.setAttribute('data-sig', sig);

    const todayKey = formatLocalYmd(win.today);
    const firstKey = win.firstStr && win.firstStr !== '--' ? win.firstStr : '';
    const list = [];
    for (let i = 0; i < win.totalDays; i++) {
      const d = addDays(win.winStart, i);
      const key = formatLocalYmd(d);
      const isFuture = d.getTime() > win.today.getTime();
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[key];
      const tokens = rec ? rec.total : 0;
      const isUnactivated = !isFuture && tokens === 0 && Boolean(firstKey && key < firstKey);
      list.push({ date: d, key, tokens, rec, isFuture, isToday: key === todayKey, isUnactivated });
    }

    let pool = colsBox._cellPool;
    if (!pool || colsBox.children.length !== 52) {
      colsBox.replaceChildren();
      pool = [];
      for (let c = 0; c < 52; c++) {
        const col = document.createElement('div');
        col.className = 'heat-week-col';
        const colCells = [];
        for (let rIdx = 0; rIdx < 7; rIdx++) {
          const cell = document.createElement('div');
          cell.className = 'heat-cell lvl-0';
          cell._meta = null;
          const showPop = () => {
            const meta = cell._meta;
            if (!meta) return;
            const d = meta.date;
            const dateLabel = currentPanelLanguage === 'en'
              ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
              : (currentPanelLanguage === 'zh-TW'
                ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
                : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`);
            heatPopDate.textContent = `${dateLabel}${meta.isToday ? t('heat.today') : (meta.key === meta.firstStr ? t('heat.firstUse') : '')}`;
            const costInfo = getDailyModelCost(meta.rec, meta.key, activeCostModel, { mode: activeCostMode });
            const costStr = costInfo.costUSD > 0 ? ` · ${formatUsdMetricDisplay(costInfo.costUSD, { detail: true })}` : '';
            heatPopVal.textContent = meta.tokens > 0
              ? `${fmtYi(meta.tokens)} Tokens${costStr}`
              : (meta.isFuture ? t('heat.future') : (meta.isUnactivated ? t('tokens.heat.unactivatedTip') : '0 Tokens'));
            if (meta.rec) {
              heatPopDet.innerHTML = `
                <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(meta.rec.input)}</span><span class="pop-det-trans">${t('heat.prompt')}</span></div>
                <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(meta.rec.output)}</span><span class="pop-det-trans">${t('heat.output')}</span></div>
                <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(meta.rec.cache)}</span><span class="pop-det-trans">${t('heat.cache')}</span></div>
              `.trim();
              heatPopDet.style.display = 'flex';
            } else {
              heatPopDet.style.display = 'none';
            }
            const r = cell.getBoundingClientRect ? cell.getBoundingClientRect() : { left: 0, top: 0, width: 10 };
            heatPop.style.left = `${r.left + r.width / 2}px`;
            heatPop.style.top = `${r.top - 6}px`;
            heatPop.style.opacity = '1';
          };
          cell.addEventListener('mouseenter', showPop);
          cell.addEventListener('mouseleave', hidePopover);
          cell.addEventListener('click', () => {
            const meta = cell._meta;
            if (!meta) return;
            showPop();
            if (!meta.isFuture && typeof handleHeatmapDaySelected === 'function') {
              handleHeatmapDaySelected(meta.key);
            }
          });
          col.appendChild(cell);
          colCells.push(cell);
        }
        colsBox.appendChild(col);
        pool.push(colCells);
      }
      colsBox._cellPool = pool;
    }

    const monthMarkers = [];
    let lastM = -1;
    let lastCol = -10;

    for (let c = 0; c < 52; c++) {
      const colCells = pool[c];
      const slice = list.slice(c * 7, (c + 1) * 7);
      const mNum = slice[0].date.getMonth() + 1;
      if (mNum !== lastM) {
        if (c - lastCol >= 3 && 52 - c >= 2) {
          monthMarkers.push({ month: mNum, colIdx: c });
          lastCol = c;
        }
        lastM = mNum;
      }

      for (let rIdx = 0; rIdx < 7; rIdx++) {
        const item = slice[rIdx];
        const cell = colCells[rIdx];
        cell._meta = { ...item, firstStr: win.firstStr };
        const lvl = getLvl(item.tokens);
        const isLinked = Boolean(cumLinkedDailyDate && item.key === cumLinkedDailyDate);
        const isDayFiltered = Boolean(csiSelDate && item.key === csiSelDate);
        cell.className = `heat-cell lvl-${lvl}${item.isFuture ? ' is-future' : ''}${item.isUnactivated ? ' is-unactivated' : ''}${item.isToday ? ' is-today' : ''}${isLinked ? ' is-cum-linked' : ''}${isDayFiltered ? ' is-day-filtered' : ''}`;
        if (item.tokens > 0 && typeof getContinuousHeatColor === 'function') {
          const contCol = getContinuousHeatColor(item.tokens, 'heat');
          if (contCol) {
            cell.style.backgroundColor = contCol;
            cell.setAttribute('data-heat-color', contCol);
          } else {
            cell.style.backgroundColor = '';
            cell.removeAttribute('data-heat-color');
          }
        } else {
          cell.style.backgroundColor = '';
          cell.removeAttribute('data-heat-color');
        }
        cell.setAttribute('data-date', item.key);
        cell.setAttribute('data-tokens', String(item.tokens));
      }
    }

    const shortMonthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    monthMarkers.forEach(mm => {
      const lbl = document.createElement('span');
      lbl.className = 'heat-month-item';
      lbl.style.left = `${mm.colIdx * 13}px`;
      lbl.textContent = currentPanelLanguage === 'en' ? (shortMonthsEn[mm.month - 1] || `${mm.month}`) : `${mm.month}月`;
      monthsBox.appendChild(lbl);
    });

    updateSummaryBar('daily', list.map(x => x.key));
  }

  function renderHeatmapWeekly() {
    const box = el('h-weekly-box');
    if (!box) return;
    box.replaceChildren();

    const scale = getEffectiveHeatmapScale();
    const [cEmpty] = scale;
    const win = computeTimelineWindow();
    const todayTs = win.today.getTime();
    const totalWeeks = 52;
    const weeksData = [];
    let maxWeekTokens = 0;

    for (let c = 0; c < totalWeeks; c++) {
      let sum = 0;
      let sDate = null, eDate = null;
      for (let r = 0; r < 7; r++) {
        const d = addDays(win.winStart, c * 7 + r);
        const k = formatLocalYmd(d);
        if (!sDate) sDate = d;
        eDate = d;
        const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
        if (rec) sum += rec.total;
      }
      const isFutureWeek = Boolean(sDate && sDate.getTime() > todayTs && sum === 0);
      if (!isFutureWeek && sum > maxWeekTokens) maxWeekTokens = sum;
      weeksData.push({ sum, sDate, eDate, startKey: formatLocalYmd(sDate), isFutureWeek });
    }

    const core = globalThis.__AGContextMeterCore || {};
    const chartPxHeight = 96;
    const env = typeof core.resolveScaleEnvelope === 'function'
      ? core.resolveScaleEnvelope(maxWeekTokens, 'weekly')
      : { tier: '400M', anchor: 400e6, hCap: 0.84, refTicks: [4e6, 40e6, 400e6], overflowThreshold: 2e9 };
    box.setAttribute('data-scale-tier', env.tier || '');

    // 绘制右侧量级参考线（统一调用 mapBarHeightPx，确保刻度与柱图位置精确一致）
    const ticks = Array.isArray(env.refTicks) ? env.refTicks : [];
    const lastTickVal = ticks.length ? ticks[ticks.length - 1] : 0;
    const visibleTicks = ticks.length > 3 ? [ticks[0], ticks[ticks.length - 2], lastTickVal] : ticks;
    visibleTicks.forEach(tickVal => {
      if (!(tickVal > 0) || typeof core.mapBarHeightPx !== 'function') return;
      const tickRes = core.mapBarHeightPx(tickVal, env, chartPxHeight, { minPx: 3.0, scaleKind: 'weekly' });
      const line = document.createElement('div');
      line.className = 'w-ref-line';
      line.style.bottom = `${(3 + tickRes.height).toFixed(2)}px`;
      const lbl = document.createElement('span');
      lbl.className = 'w-ref-lbl';
      const isCeilingOverflowTick = Boolean(env.overflow && tickVal === lastTickVal);
      lbl.textContent = isCeilingOverflowTick ? `${formatCompactTokenCount(tickVal)}+` : formatCompactTokenCount(tickVal);
      line.appendChild(lbl);
      box.appendChild(line);
    });

    weeksData.forEach(w => {
      const col = document.createElement('div');
      col.className = 'w-bar-col';
      col.setAttribute('data-week-start', w.startKey);
      col.setAttribute('data-tokens', String(w.sum));
      const fill = document.createElement('div');
      if (w.sum <= 0 || w.isFutureWeek) {
        fill.className = 'w-bar-fill is-empty';
        fill.style.height = '1px';
        fill.style.backgroundColor = cEmpty;
      } else {
        const barRes = typeof core.mapBarHeightPx === 'function'
          ? core.mapBarHeightPx(w.sum, env, chartPxHeight, { minPx: 3.0, scaleKind: 'weekly' })
          : { height: Math.max(3, (w.sum / Math.max(1, maxWeekTokens)) * chartPxHeight), overflow: false };
        fill.className = `w-bar-fill${barRes.overflow ? ' is-overflow' : ''}`;
        fill.style.height = `${barRes.height.toFixed(2)}px`;
        const colHex = typeof getContinuousHeatColor === 'function'
          ? getContinuousHeatColor(w.sum, 'weekly')
          : scale[4];
        fill.style.backgroundColor = colHex || scale[4];
      }
      col.appendChild(fill);

      const showPop = () => {
        const weekDates = [];
        for (let r = 0; r < 7; r++) weekDates.push(formatLocalYmd(addDays(w.sDate, r)));
        const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, weekDates, activeCostModel, {
          mode: activeCostMode,
          todayStr: formatLocalYmd(win.today)
        });
        const costStr = costAgg.totalCostUSD > 0 ? ` · ${formatUsdMetricDisplay(costAgg.totalCostUSD, { detail: true })}` : '';
        heatPopDate.textContent = `${w.sDate.getFullYear()}.${w.sDate.getMonth() + 1}.${w.sDate.getDate()} - ${w.eDate.getMonth() + 1}.${w.eDate.getDate()}`;
        heatPopVal.textContent = w.sum > 0 ? `${fmtYi(w.sum)} Tokens${costStr}` : (w.isFutureWeek ? t('tokens.heat.futureTip') : '0 Tokens');
        heatPopDet.innerHTML = `<span>${t('heat.weeklyTotal', { avg: costAgg.dailyAverageUSD.toFixed(2) })}</span>`;
        heatPopDet.style.display = 'block';
        const r = col.getBoundingClientRect();
        heatPop.style.left = `${r.left + r.width / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      col.addEventListener('mouseenter', showPop);
      col.addEventListener('mouseleave', hidePopover);
      col.addEventListener('click', showPop);

      box.appendChild(col);
    });

    const allWinDates = [];
    for (let i = 0; i < win.totalDays; i++) allWinDates.push(formatLocalYmd(addDays(win.winStart, i)));
    updateSummaryBar('weekly', allWinDates);
  }

  function renderHeatmapCum() {
    const box = el('h-cum-box');
    if (!box) return;
    box.replaceChildren();

    const core = globalThis.__AGContextMeterCore || {};
    const win = computeTimelineWindow();
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const todayKey = formatLocalYmd(win.today);
    // 当前窗口截断到今天；历史翻页窗口展示到该区间末日
    const activeEnd = win.winEnd.getTime() > win.today.getTime() ? win.today : win.winEnd;
    const startKey = formatLocalYmd(win.winStart);
    const endKey = formatLocalYmd(activeEnd);

    const rangeEl = el('h-win-range');
    if (rangeEl) rangeEl.textContent = `${formatDotYmd(win.winStart)} – ${formatDotYmd(activeEnd)}`;

    const summary = typeof core.computeCumulativeStripSummary === 'function'
      ? core.computeCumulativeStripSummary(map, startKey, endKey)
      : {
        startDate: startKey, endDate: endKey, totalDays: 0, activeDays: 0, zeroDays: 0,
        intervalTotal: 0, grouping: 'daily', dailyEntries: [], segments: [], topPeaks: [],
        mergedPeakSpans: [], peakDay: null, peakWeek: null, concentration: null,
        concentrationOmittedReason: 'empty', ruler: { status: 'zero', pct: 0, value: 0, ticks: [] }
      };
    _lastCumSummary = summary;

    // 切换账号/区间后若锁定键不再属于当前窗口，自动清理失效选中项
    if (cumLockedKey && !summary.segments.some(s => s.key === cumLockedKey)) {
      cumLockedKey = null;
      cumExpandedWeekKey = null;
    }
    if (cumHoveredKey && !summary.segments.some(s => s.key === cumHoveredKey)) {
      cumHoveredKey = null;
    }

    const rangeDates = summary.dailyEntries.map(d => d.date);
    const costAgg = calculateIntervalCost(map, rangeDates, activeCostModel, {
      mode: activeCostMode,
      todayStr: todayKey
    });
    const costText = formatUsdMetricDisplay(costAgg.totalCostUSD);

    const scrollBox = el('h-scroll-box') || box.parentElement;
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const W = (rect && rect.width > 120) ? rect.width : 670;
    const isNarrow = W < 460;

    const rootEl = document.createElement('div');
    rootEl.className = `cum-root${isNarrow ? ' is-narrow' : ''}`;
    rootEl.setAttribute('data-grouping', summary.grouping);
    rootEl.setAttribute('data-total-days', String(summary.totalDays));
    rootEl.setAttribute('data-interval-total', String(summary.intervalTotal));

    // 1. 顶部数字行（总量与参考金额各只在此处显示一次）
    const headRow = document.createElement('div');
    headRow.className = 'cum-summary-head';

    const headLeft = document.createElement('div');
    headLeft.className = 'cum-head-left';

    const totalBig = document.createElement('span');
    totalBig.className = 'cum-total-big';
    totalBig.id = 'cum-head-total';
    totalBig.textContent = `${fmtYi(summary.intervalTotal)} Tokens`;
    totalBig.title = `${summary.intervalTotal.toLocaleString()} Tokens`;

    const metaText = document.createElement('span');
    metaText.className = 'cum-meta-text';
    metaText.id = 'cum-head-meta';
    const rangeTxt = t('tokens.cum.daysMeta', {
      start: formatCumShortDate(summary.startDate),
      end: formatCumShortDate(summary.endDate),
      total: summary.totalDays
    });
    const activeTxt = t('tokens.cum.activeMeta', { active: summary.activeDays, zero: summary.zeroDays });
    metaText.textContent = summary.totalDays < 7
      ? `${rangeTxt} · ${t('tokens.cum.recordDaysShort', { total: summary.totalDays })} · ${activeTxt}`
      : `${rangeTxt} · ${activeTxt}`;

    headLeft.appendChild(totalBig);
    headLeft.appendChild(metaText);

    const headCost = document.createElement('span');
    headCost.className = 'cum-head-cost';
    headCost.id = 'cum-head-cost';
    headCost.textContent = costText;
    headCost.title = formatUsdMetricTooltip(costAgg.totalCostUSD);

    headRow.appendChild(headLeft);
    headRow.appendChild(headCost);
    rootEl.appendChild(headRow);

    // 2. 跨账号共用的对数量级尺 (10M / 100M / 1B / 10B / 100B)
    const rulerCard = document.createElement('div');
    rulerCard.className = 'cum-ruler-card';
    rulerCard.setAttribute('data-ruler-status', summary.ruler.status);

    const rulerTop = document.createElement('div');
    rulerTop.className = 'cum-ruler-top';
    const rulerLbl = document.createElement('span');
    rulerLbl.textContent = t('tokens.cum.rulerLabel');
    const rulerBadge = document.createElement('span');
    rulerBadge.className = 'cum-ruler-badge';
    rulerBadge.id = 'cum-ruler-badge';
    if (summary.ruler.status === 'zero') {
      rulerBadge.classList.add('is-zero');
      rulerBadge.textContent = t('tokens.cum.zeroVal');
    } else if (summary.ruler.status === 'below_min') {
      rulerBadge.classList.add('is-below-min');
      rulerBadge.textContent = t('tokens.cum.belowMin', { val: fmtYi(summary.intervalTotal) });
    } else if (summary.ruler.status === 'above_max') {
      rulerBadge.classList.add('is-above-max');
      rulerBadge.textContent = t('tokens.cum.aboveMax', { val: fmtYi(summary.intervalTotal) });
    } else {
      rulerBadge.textContent = fmtYi(summary.intervalTotal);
    }
    rulerTop.appendChild(rulerLbl);
    rulerTop.appendChild(rulerBadge);
    rulerCard.appendChild(rulerTop);

    const rulerWrap = document.createElement('div');
    rulerWrap.className = 'cum-ruler-track-wrap';
    const rulerTrack = document.createElement('div');
    rulerTrack.className = 'cum-ruler-track';
    rulerWrap.appendChild(rulerTrack);

    (summary.ruler.ticks || []).forEach((tk, idx, arr) => {
      const tickEl = document.createElement('div');
      tickEl.className = 'cum-ruler-tick';
      tickEl.style.left = `${tk.pct}%`;
      if (idx === 0) tickEl.setAttribute('data-edge', 'start');
      else if (idx === arr.length - 1) tickEl.setAttribute('data-edge', 'end');
      if (idx === 1 || idx === 3) tickEl.setAttribute('data-mid', 'true');
      const tickLbl = document.createElement('span');
      tickLbl.className = 'cum-ruler-tick-lbl';
      tickLbl.textContent = tk.label;
      tickEl.appendChild(tickLbl);
      rulerWrap.appendChild(tickEl);
    });

    const marker = document.createElement('div');
    marker.className = `cum-ruler-marker${summary.ruler.status === 'below_min' ? ' is-below-min' : ''}${summary.ruler.status === 'above_max' ? ' is-above-max' : ''}${summary.ruler.status === 'zero' ? ' is-zero' : ''}`;
    marker.id = 'cum-ruler-marker';
    marker.style.left = `${summary.ruler.pct.toFixed(2)}%`;
    marker.setAttribute('data-ruler-pct', summary.ruler.pct.toFixed(2));
    marker.setAttribute('data-ruler-status', summary.ruler.status);
    const tri = document.createElement('div');
    tri.className = 'cum-ruler-tri';
    marker.appendChild(tri);
    rulerWrap.appendChild(marker);
    rulerCard.appendChild(rulerWrap);
    rootEl.appendChild(rulerCard);

    // 3. 空态处理（总量为 0，避免除零）
    if (summary.intervalTotal <= 0) {
      const emptyBox = document.createElement('div');
      emptyBox.className = 'cum-empty-state';
      emptyBox.id = 'cum-empty-state';
      const emptyTitle = document.createElement('div');
      emptyTitle.className = 'cum-empty-title';
      emptyTitle.textContent = t('tokens.cum.emptyTitle');
      const emptySub = document.createElement('div');
      emptySub.className = 'cum-empty-sub';
      emptySub.textContent = t('tokens.cum.emptySub', { days: summary.totalDays });
      emptyBox.appendChild(emptyTitle);
      emptyBox.appendChild(emptySub);
      rootEl.appendChild(emptyBox);
      box.appendChild(rootEl);
      updateSummaryBar('cum', rangeDates);
      return;
    }

    // 4. 主图：比例时间带 + 高峰标签 + 连接线 + 等距日期轴
    const stripSection = document.createElement('div');
    stripSection.className = 'cum-strip-section';

    const peakChipsRow = document.createElement('div');
    peakChipsRow.className = 'cum-peak-chips';
    peakChipsRow.id = 'cum-peak-chips';
    summary.mergedPeakSpans.forEach(sp => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `cum-peak-chip${cumLockedKey && sp.itemKeys.includes(cumLockedKey) ? ' is-active' : ''}`;
      const rangeStr = sp.startDate === sp.endDate
        ? formatCumShortDate(sp.startDate)
        : `${formatCumShortDate(sp.startDate)}–${formatCumShortDate(sp.endDate)}`;
      chip.textContent = t('tokens.cum.peakSpanFmt', {
        range: rangeStr,
        pct: sp.sharePct >= 10 ? sp.sharePct.toFixed(0) : sp.sharePct.toFixed(1)
      });
      chip.addEventListener('click', () => {
        const firstKey = sp.itemKeys[0];
        cumLockedKey = (cumLockedKey === firstKey) ? null : firstKey;
        if (summary.grouping === 'weekly') cumExpandedWeekKey = cumLockedKey;
        renderHeatmapCum();
      });
      peakChipsRow.appendChild(chip);
    });
    if (summary.grouping === 'weekly') {
      const grpHint = document.createElement('span');
      grpHint.className = 'cum-group-hint';
      grpHint.textContent = t('tokens.cum.weekGroupHint', { n: summary.segments.length });
      peakChipsRow.appendChild(grpHint);
    }
    stripSection.appendChild(peakChipsRow);

    const stripEl = document.createElement('div');
    stripEl.className = 'cum-strip';
    stripEl.id = 'cum-strip';

    const createSvgNode = tag => {
      if (typeof document !== 'undefined' && typeof document.createElementNS === 'function') {
        return document.createElementNS('http://www.w3.org/2000/svg', tag);
      }
      return document.createElement(tag);
    };
    const connSvg = createSvgNode('svg');
    connSvg.setAttribute('class', 'cum-connectors-svg');
    connSvg.setAttribute('viewBox', '0 0 1000 18');
    connSvg.setAttribute('preserveAspectRatio', 'none');

    const axisRow = document.createElement('div');
    axisRow.className = 'cum-axis-row';
    axisRow.id = 'cum-axis-row';

    const isLight = typeof resolveEffectiveTheme === 'function' && resolveEffectiveTheme() === 'light';
    const segPaletteDark = [
      'color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 42%, #0f172a)',
      'color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 60%, #0f172a)',
      'color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 78%, #0f172a)',
      'var(--ag-host-accent, var(--primary, #3274f6))'
    ];
    const segPaletteLight = [
      'color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 58%, #ffffff)',
      'color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 74%, #ffffff)',
      'color-mix(in srgb, var(--ag-host-accent, var(--primary, #3274f6)) 88%, #ffffff)',
      'var(--ag-host-accent, var(--primary, #3274f6))'
    ];
    const segPalette = isLight ? segPaletteLight : segPaletteDark;

    const showSegPop = (seg, anchorNode) => {
      const segDates = seg.days.map(d => d.date);
      const segCost = calculateIntervalCost(map, segDates, activeCostModel, { mode: activeCostMode, todayStr: todayKey });
      const costSuffix = segCost.totalCostUSD > 0 ? ` · ${formatUsdMetricDisplay(segCost.totalCostUSD, { detail: true })}` : '';
      const dateTitle = seg.startDate === seg.endDate
        ? seg.startDate
        : `${seg.startDate} – ${seg.endDate} (${seg.daysCount}d)`;
      heatPopDate.textContent = `${dateTitle}${t('heat.cumSuffix')}`;
      const deltaPrefix = summary.grouping === 'weekly' ? t('tokens.cum.weekSumLbl') : t('tokens.heat.cumDeltaLbl');
      heatPopVal.textContent = seg.tokens > 0
        ? `${deltaPrefix}: +${fmtYi(seg.tokens)} (${seg.sharePct.toFixed(1)}%)${costSuffix}`
        : `0 Tokens (0.0%)`;
      heatPopDet.innerHTML = `<span>${t('tokens.heat.cumTotalLbl')}: ${fmtYi(seg.cumulativeTokens)} Tokens (${summary.intervalTotal > 0 ? ((seg.cumulativeTokens / summary.intervalTotal) * 100).toFixed(1) : '0.0'}%)</span>`;
      heatPopDet.style.display = 'block';
      const r = anchorNode && anchorNode.getBoundingClientRect ? anchorNode.getBoundingClientRect() : { left: 100, top: 100, width: 20 };
      heatPop.style.left = `${r.left + (r.width || 0) / 2}px`;
      heatPop.style.top = `${r.top - 6}px`;
      heatPop.style.opacity = '1';
    };

    const segNodeMap = new Map();
    const axisNodeMap = new Map();
    const connNodeMap = new Map();

    const syncCumActiveVisuals = () => {
      const focusKey = cumHoveredKey || cumLockedKey || null;
      summary.segments.forEach(s => {
        const segEl = segNodeMap.get(s.key);
        const axEl = axisNodeMap.get(s.key);
        const lnEl = connNodeMap.get(s.key);
        const isAct = Boolean(focusKey && s.key === focusKey);
        const isDim = Boolean(focusKey && s.key !== focusKey);
        if (segEl) {
          segEl.classList?.toggle?.('is-active', isAct);
          if (!segEl.classList?.toggle) {
            if (isAct) segEl.classList?.add?.('is-active'); else segEl.classList?.remove?.('is-active');
          }
          if (isDim) segEl.classList?.add?.('is-dimmed'); else segEl.classList?.remove?.('is-dimmed');
        }
        if (axEl) {
          if (isAct) axEl.classList?.add?.('is-active'); else axEl.classList?.remove?.('is-active');
        }
        if (lnEl) {
          const curCls = lnEl.getAttribute('class') || 'cum-conn-line';
          lnEl.setAttribute('class', isAct ? 'cum-conn-line is-active' : 'cum-conn-line');
        }
      });
    };

    let activeBarIdx = 0;
    let lastShownLblPct = -999;
    const totalSegs = summary.segments.length;

    summary.segments.forEach((seg, sIdx) => {
      const isActiveFocus = Boolean((cumHoveredKey || cumLockedKey) === seg.key);

      // 横带仅含非零日/周；零用量日不占宽
      if (seg.tokens > 0 && seg.stripWidthPct > 0) {
        const segBtn = document.createElement('button');
        segBtn.type = 'button';
        segBtn.className = `cum-seg${seg.isPeak ? ' is-peak' : ''}${isActiveFocus ? ' is-active' : ''}`;
        segBtn.style.width = `${seg.stripWidthPct.toFixed(6)}%`;
        const colBg = seg.isPeak
          ? 'var(--ag-host-accent, var(--primary, #3274f6))'
          : segPalette[(seg.weekIdx * 2 + (activeBarIdx % 2)) % segPalette.length];
        segBtn.style.backgroundColor = colBg;
        segBtn.setAttribute('data-cum-key', seg.key);
        segBtn.setAttribute('data-tokens', String(seg.tokens));
        segBtn.setAttribute('data-width-pct', seg.stripWidthPct.toFixed(4));
        segBtn.setAttribute('data-cum-tokens', String(seg.cumulativeTokens));
        segBtn.setAttribute('aria-label', `${seg.startDate === seg.endDate ? seg.startDate : `${seg.startDate}–${seg.endDate}`}: ${fmtYi(seg.tokens)} (${seg.sharePct.toFixed(1)}%), ${t('tokens.heat.cumTotalLbl')} ${fmtYi(seg.cumulativeTokens)}`);

        if (!isNarrow && seg.stripWidthPct >= 10) {
          const lbl = document.createElement('span');
          lbl.className = 'cum-seg-lbl';
          lbl.textContent = seg.isPeak
            ? `${formatCumShortDate(seg.startDate)} ${seg.sharePct.toFixed(0)}%`
            : formatCumShortDate(seg.startDate);
          segBtn.appendChild(lbl);
        }

        const onEnter = () => {
          cumHoveredKey = seg.key;
          syncCumActiveVisuals();
          showSegPop(seg, segBtn);
        };
        const onLeave = () => {
          if (cumHoveredKey === seg.key) cumHoveredKey = null;
          syncCumActiveVisuals();
          hidePopover();
        };
        const onClick = () => {
          cumLockedKey = (cumLockedKey === seg.key) ? null : seg.key;
          cumExpandedWeekKey = cumLockedKey && summary.grouping === 'weekly' ? cumLockedKey : null;
          renderHeatmapCum();
        };
        segBtn.addEventListener('mouseenter', onEnter);
        segBtn.addEventListener('focus', onEnter);
        segBtn.addEventListener('mouseleave', onLeave);
        segBtn.addEventListener('blur', onLeave);
        segBtn.addEventListener('click', onClick);

        stripEl.appendChild(segBtn);
        segNodeMap.set(seg.key, segBtn);
        activeBarIdx += 1;

        // 细连接线（仅连接非零有效段到等距刻度点）
        const connLine = createSvgNode('line');
        connLine.setAttribute('class', `cum-conn-line${isActiveFocus ? ' is-active' : ''}`);
        connLine.setAttribute('data-cum-key', seg.key);
        connLine.setAttribute('x1', (seg.stripCenterPct * 10).toFixed(2));
        connLine.setAttribute('y1', '0');
        connLine.setAttribute('x2', (seg.equidistantPct * 10).toFixed(2));
        connLine.setAttribute('y2', '18');
        connSvg.appendChild(connLine);
        connNodeMap.set(seg.key, connLine);
      }

      // 等距日期轴（含 0 用量日 ✕ 标记）
      const slotBtn = document.createElement('button');
      slotBtn.type = 'button';
      slotBtn.className = `cum-axis-slot${seg.isZero ? ' is-zero' : ''}${isActiveFocus ? ' is-active' : ''}`;
      slotBtn.style.left = `${seg.equidistantPct.toFixed(4)}%`;
      slotBtn.setAttribute('data-cum-key', seg.key);
      if (seg.isZero) slotBtn.setAttribute('data-zero', 'true');
      slotBtn.setAttribute('aria-label', `${seg.startDate}: ${seg.isZero ? '0 Tokens' : fmtYi(seg.tokens)}`);

      if (seg.isZero) {
        const zMark = document.createElement('span');
        zMark.className = 'cum-axis-zero';
        zMark.textContent = '✕';
        slotBtn.appendChild(zMark);
      } else {
        const dot = document.createElement('span');
        dot.className = `cum-axis-dot${seg.isPeak ? ' is-peak' : ''}`;
        slotBtn.appendChild(dot);
      }

      const isFirst = sIdx === 0;
      const isLast = sIdx === totalSegs - 1;
      const canPlaceMid = !isFirst && !isLast && (seg.equidistantPct - lastShownLblPct >= 14) && (100 - seg.equidistantPct >= 11);
      if (isFirst || isLast || (canPlaceMid && (seg.isZero || seg.isPeak))) {
        const lbl = document.createElement('span');
        lbl.className = 'cum-axis-lbl';
        lbl.textContent = seg.isZero ? `${formatCumShortDate(seg.startDate)}(0)` : formatCumShortDate(seg.startDate);
        slotBtn.appendChild(lbl);
        lastShownLblPct = seg.equidistantPct;
      }

      const onAxisEnter = () => {
        cumHoveredKey = seg.key;
        syncCumActiveVisuals();
        showSegPop(seg, slotBtn);
      };
      const onAxisLeave = () => {
        if (cumHoveredKey === seg.key) cumHoveredKey = null;
        syncCumActiveVisuals();
        hidePopover();
      };
      const onAxisClick = () => {
        cumLockedKey = (cumLockedKey === seg.key) ? null : seg.key;
        cumExpandedWeekKey = cumLockedKey && summary.grouping === 'weekly' ? cumLockedKey : null;
        renderHeatmapCum();
      };
      slotBtn.addEventListener('mouseenter', onAxisEnter);
      slotBtn.addEventListener('focus', onAxisEnter);
      slotBtn.addEventListener('mouseleave', onAxisLeave);
      slotBtn.addEventListener('blur', onAxisLeave);
      slotBtn.addEventListener('click', onAxisClick);

      axisRow.appendChild(slotBtn);
      axisNodeMap.set(seg.key, slotBtn);
    });

    stripSection.appendChild(stripEl);
    stripSection.appendChild(connSvg);
    stripSection.appendChild(axisRow);
    rootEl.appendChild(stripSection);

    // 5. 结论行（基于真实数据计算，不写死）
    const concRow = document.createElement('div');
    concRow.className = `cum-conclusion-row${summary.concentrationOmittedReason === 'insufficient_days' ? ' is-insufficient' : ''}`;
    concRow.id = 'cum-conclusion-row';
    const concParts = [];
    if (summary.concentration) {
      concParts.push(t('tokens.cum.concLine', {
        start: formatCumShortDate(summary.concentration.startDate),
        end: formatCumShortDate(summary.concentration.endDate),
        n: summary.concentration.daysCount,
        pct: summary.concentration.sharePct.toFixed(1)
      }));
    } else if (summary.concentrationOmittedReason === 'insufficient_days') {
      concParts.push(t('tokens.cum.concInsufficient'));
    }
    if (summary.grouping === 'weekly' && summary.peakWeek) {
      concParts.push(t('tokens.cum.peakWeekFmt', {
        range: `${formatCumShortDate(summary.peakWeek.startDate)}–${formatCumShortDate(summary.peakWeek.endDate)}`,
        val: fmtYi(summary.peakWeek.tokens),
        pct: summary.peakWeek.sharePct.toFixed(1)
      }));
    } else if (summary.peakDay) {
      concParts.push(t('tokens.cum.peakDayFmt', {
        date: formatCumShortDate(summary.peakDay.date),
        val: fmtYi(summary.peakDay.tokens),
        pct: summary.peakDay.sharePct.toFixed(1)
      }));
    }
    concRow.textContent = concParts.join(' · ');
    rootEl.appendChild(concRow);

    // 6. 锁定详情与联动「每天」热力图 / 周展开到日
    const lockedSeg = cumLockedKey ? summary.segments.find(s => s.key === cumLockedKey) : null;
    if (lockedSeg) {
      const insp = document.createElement('div');
      insp.className = 'cum-inspector';
      insp.id = 'cum-inspector';

      const inspTop = document.createElement('div');
      inspTop.className = 'cum-insp-top';

      const metrics = document.createElement('div');
      metrics.className = 'cum-insp-metrics';
      const titleDate = lockedSeg.startDate === lockedSeg.endDate
        ? lockedSeg.startDate
        : `${lockedSeg.startDate} – ${lockedSeg.endDate}`;
      const deltaTitle = summary.grouping === 'weekly' ? t('tokens.cum.weekSumLbl') : t('tokens.heat.cumDeltaLbl');
      metrics.innerHTML = `<strong>${titleDate}</strong><span>${deltaTitle}: <strong>+${fmtYi(lockedSeg.tokens)}</strong></span><span>${t('tokens.cum.shareLbl')}: <strong>${lockedSeg.sharePct.toFixed(1)}%</strong></span><span>${t('tokens.heat.cumTotalLbl')}: <strong>${fmtYi(lockedSeg.cumulativeTokens)}</strong></span>`;

      const actions = document.createElement('div');
      actions.className = 'cum-insp-actions';

      if (summary.grouping === 'weekly' && lockedSeg.days.length > 0) {
        const isExpanded = cumExpandedWeekKey === lockedSeg.key;
        const expBtn = document.createElement('button');
        expBtn.type = 'button';
        expBtn.className = 'cum-mini-btn';
        expBtn.id = 'cum-btn-expand-days';
        expBtn.textContent = isExpanded
          ? t('tokens.cum.collapseDays')
          : t('tokens.cum.expandDays', { n: lockedSeg.days.length });
        expBtn.addEventListener('click', () => {
          cumExpandedWeekKey = isExpanded ? null : lockedSeg.key;
          renderHeatmapCum();
        });
        actions.appendChild(expBtn);
      }

      const locBtn = document.createElement('button');
      locBtn.type = 'button';
      locBtn.className = 'cum-mini-btn';
      locBtn.id = 'cum-btn-locate-daily';
      locBtn.textContent = t('tokens.cum.locateDaily');
      locBtn.addEventListener('click', () => {
        const targetDay = lockedSeg.days && lockedSeg.days.length
          ? lockedSeg.days.slice().sort((a, b) => b.tokens - a.tokens)[0].date
          : lockedSeg.startDate;
        locateDayInDailyHeatmap(targetDay);
      });
      actions.appendChild(locBtn);

      const clrBtn = document.createElement('button');
      clrBtn.type = 'button';
      clrBtn.className = 'cum-mini-btn';
      clrBtn.id = 'cum-btn-clear-lock';
      clrBtn.textContent = t('tokens.cum.clearLock');
      clrBtn.addEventListener('click', () => { clearCumLockAndRefresh(); });
      actions.appendChild(clrBtn);

      inspTop.appendChild(metrics);
      inspTop.appendChild(actions);
      insp.appendChild(inspTop);

      if (summary.grouping === 'weekly' && cumExpandedWeekKey === lockedSeg.key && lockedSeg.days.length > 0) {
        const daysList = document.createElement('div');
        daysList.className = 'cum-week-days';
        daysList.id = 'cum-week-days';
        lockedSeg.days.forEach(dayObj => {
          const dayBtn = document.createElement('button');
          dayBtn.type = 'button';
          dayBtn.className = `cum-day-row-btn${cumLinkedDailyDate === dayObj.date ? ' is-active' : ''}`;
          dayBtn.setAttribute('data-day-date', dayObj.date);
          const leftD = document.createElement('span');
          leftD.textContent = formatCumShortDate(dayObj.date);
          const rightD = document.createElement('span');
          rightD.textContent = dayObj.tokens > 0
            ? `${fmtYi(dayObj.tokens)} (${dayObj.sharePct.toFixed(1)}%)`
            : t('tokens.cum.zeroDayBadge');
          dayBtn.appendChild(leftD);
          dayBtn.appendChild(rightD);
          dayBtn.addEventListener('click', () => locateDayInDailyHeatmap(dayObj.date));
          daysList.appendChild(dayBtn);
        });
        insp.appendChild(daysList);
      }

      rootEl.appendChild(insp);
    }

    box.appendChild(rootEl);
    updateSummaryBar('cum', rangeDates);
  }

  function updateSummaryBar(viewType, dateKeys = []) {
    const sumTokensEl = el('h-sum-tokens');
    const sumCostEl = el('h-sum-cost');
    const sumTokensWrap = el('h-sum-tokens-wrap');
    const sumCostWrap = el('h-sum-cost-wrap');
    const sumDailyAvgEl = el('h-sum-daily-avg');
    const sumActiveAvgEl = el('h-sum-active-avg');
    const subRatioWrapEl = el('h-sum-sub-ratio-wrap');
    const subRatioEl = el('h-sum-sub-ratio');
    if (!sumTokensEl || !sumCostEl) return;

    const isCum = viewType === 'cum';
    if (sumTokensWrap) sumTokensWrap.style.display = isCum ? 'none' : '';
    if (sumCostWrap) sumCostWrap.style.display = isCum ? 'none' : '';

    const win = computeTimelineWindow();
    const todayStr = formatLocalYmd(win.today);
    const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, dateKeys, activeCostModel, {
      mode: activeCostMode,
      todayStr
    });

    sumTokensEl.textContent = `${fmtYi(costAgg.totalTokens)} Tokens`;
    sumCostEl.textContent = formatUsdMetricDisplay(costAgg.totalCostUSD);
    sumCostEl.title = formatUsdMetricTooltip(costAgg.totalCostUSD);
    sumDailyAvgEl.textContent = `$${costAgg.dailyAverageUSD.toFixed(2)}`;
    sumActiveAvgEl.textContent = t('heat.activeDays', { avg: costAgg.activeDailyAverageUSD.toFixed(2), days: costAgg.activeDays });

    if ((viewType === 'monthly' || viewType === 'yearly') && subRatioWrapEl && subRatioEl) {
      const plan = resolveEffectivePlanStatus(ANTIGRAVITY_TOKEN_DATA.planStatus, ANTIGRAVITY_TOKEN_DATA.customPlanSettings);
      const paidVal = plan.actualPricePaid ?? plan.pricePaid ?? plan.officialPriceMonthly ?? null;
      const isZeroCost = plan.isZeroExtraCost || paidVal === 0;
      if (!isZeroCost && paidVal > 0 && costAgg.totalCostUSD > 0) {
        const subMonthlyUSD = convertCurrencyUi(paidVal, plan.currency || 'USD', 'USD', plan.region)
          ?? (plan.actualPricePaidUSD || (plan.actualPricePaidCNY ? plan.actualPricePaidCNY / 6.72 : paidVal));
        if (subMonthlyUSD > 0) {
          const ratio = (costAgg.totalCostUSD / (viewType === 'yearly' ? subMonthlyUSD * 12 : subMonthlyUSD)).toFixed(1);
          subRatioEl.textContent = t('heat.roi', { ratio });
          subRatioWrapEl.style.display = 'inline-flex';
        } else {
          subRatioWrapEl.style.display = 'none';
        }
      } else {
        subRatioWrapEl.style.display = 'none';
      }
    } else if (subRatioWrapEl) {
      subRatioWrapEl.style.display = 'none';
    }
  }

  function renderHeatmapMonthly() {
    const box = el('h-monthly-box');
    if (!box) return;
    box.replaceChildren();

    const scrollBox = el('h-scroll-box') || box.parentElement;
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const W = (rect && rect.width > 200) ? Math.floor(rect.width - 16) : 670;
    const H = 95;

    const scale = getEffectiveHeatmapScale();
    const win = computeTimelineWindow();
    const today = win.today;
    const todayKey = formatLocalYmd(today);

    // 计算当前所选月 (按 heatMonthOffset 自然月偏移)
    const targetDate = new Date(today.getFullYear(), today.getMonth() + heatMonthOffset, 1);
    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();
    const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();

    const gap = 5;
    let bestR = 1, bestC = daysInMonth, bestS = 0;
    for (let r = 1; r <= 7; r++) {
      const c = Math.ceil(daysInMonth / r);
      const s = Math.min((W - (c - 1) * gap) / c, (H - (r - 1) * gap) / r);
      if (s > bestS) {
        bestS = s;
        bestR = r;
        bestC = c;
      }
    }
    bestS = Math.floor(bestS);
    const showDayNum = bestS >= 22;

    const grid = document.createElement('div');
    grid.className = 'heat-month-grid';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${bestC}, ${bestS}px)`;
    grid.style.gridAutoRows = `${bestS}px`;
    grid.style.gap = `${gap}px`;
    grid.style.justifyContent = 'center';
    grid.style.alignContent = 'center';
    grid.style.height = `${H}px`;

    const dateKeys = [];
    const firstKey = win.firstStr && win.firstStr !== '--' ? win.firstStr : '';
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(targetYear, targetMonth, day);
      const k = formatLocalYmd(d);
      dateKeys.push(k);
      const isFuture = d.getTime() > today.getTime();
      const isToday = k === todayKey;
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
      const tokens = rec ? rec.total : 0;
      const isUnactivated = !isFuture && tokens === 0 && Boolean(firstKey && k < firstKey);
      const lvl = getLvl(tokens);
      const contCol = (!isFuture && tokens > 0 && typeof getContinuousHeatColor === 'function')
        ? getContinuousHeatColor(tokens, 'heat')
        : null;

      const isDayFiltered = Boolean(typeof state !== 'undefined' && state?.csiSelectedDate && k === state.csiSelectedDate);
      const cell = document.createElement('div');
      cell.className = `heat-month-cell heat-cell lvl-${lvl}${isFuture ? ' is-future' : ''}${isUnactivated ? ' is-unactivated' : ''}${isToday ? ' is-today' : ''}${isDayFiltered ? ' is-day-filtered' : ''}`;
      cell.style.width = `${bestS}px`;
      cell.style.height = `${bestS}px`;
      cell.style.backgroundColor = contCol || scale[lvl];
      if (contCol) cell.setAttribute('data-heat-color', contCol);
      cell.setAttribute('data-date', k);
      cell.setAttribute('data-tokens', String(tokens));

      if (showDayNum) {
        const numSpan = document.createElement('span');
        numSpan.className = 'heat-month-cell-num';
        numSpan.textContent = String(day);
        cell.appendChild(numSpan);
      }

      const showPop = () => {
        const costInfo = getDailyModelCost(rec, k, activeCostModel, { mode: activeCostMode });
        const costStr = costInfo.costUSD > 0 ? ` · ${formatUsdMetricDisplay(costInfo.costUSD, { detail: true })}` : '';
        const mDateLabel = currentPanelLanguage === 'en'
          ? `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          : (currentPanelLanguage === 'zh-TW'
            ? `${targetYear} 年 ${targetMonth + 1} 月 ${day} 日`
            : `${targetYear}年${targetMonth + 1}月${day}日`);
        heatPopDate.textContent = `${mDateLabel}${isToday ? t('heat.today') : ''}`;
        heatPopVal.textContent = tokens > 0
          ? `${fmtYi(tokens)} Tokens${costStr}`
          : (isFuture ? t('heat.future') : (isUnactivated ? t('tokens.heat.unactivatedTip') : '0 Tokens'));
        if (rec) {
          heatPopDet.innerHTML = `
            <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(rec.input)}</span><span class="pop-det-trans">${t('heat.prompt')}</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(rec.output)}</span><span class="pop-det-trans">${t('heat.output')}</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(rec.cache)}</span><span class="pop-det-trans">${t('heat.cache')}</span></div>
          `.trim();
          heatPopDet.style.display = 'flex';
        } else {
          heatPopDet.style.display = 'none';
        }
        const r = cell.getBoundingClientRect();
        heatPop.style.left = `${r.left + r.width / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      cell.addEventListener('mouseenter', showPop);
      cell.addEventListener('mouseleave', hidePopover);
      cell.addEventListener('click', () => {
        showPop();
        if (!isFuture && typeof handleHeatmapDaySelected === 'function') {
          handleHeatmapDaySelected(k);
        }
      });

      grid.appendChild(cell);
    }

    box.appendChild(grid);
    updateSummaryBar('monthly', dateKeys);
  }

  function renderHeatmapYearly() {
    const box = el('h-yearly-box');
    if (!box) return;
    box.replaceChildren();

    const scrollBox = el('h-scroll-box') || box.parentElement;
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const W = (rect && rect.width > 200) ? Math.floor(rect.width - 16) : 670;
    const H = 98;

    const scale = getEffectiveHeatmapScale();
    const win = computeTimelineWindow();
    const today = win.today;
    const thisYear = today.getFullYear();
    const thisMonth = today.getMonth();
    const targetYear = thisYear + heatYearOffset;
    const firstYm = (win.firstStr && win.firstStr.length >= 7 && win.firstStr !== '--') ? win.firstStr.slice(0, 7) : '';

    const monthsData = [];
    const allYearDates = [];
    let maxMonthTokens = 0;

    for (let m = 0; m < 12; m++) {
      const daysCount = new Date(targetYear, m + 1, 0).getDate();
      let mTokens = 0;
      const mDates = [];
      for (let d = 1; d <= daysCount; d++) {
        const dateObj = new Date(targetYear, m, d);
        const k = formatLocalYmd(dateObj);
        mDates.push(k);
        allYearDates.push(k);
        const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
        if (rec) mTokens += rec.total;
      }
      const isCurrent = (targetYear === thisYear && m === thisMonth);
      const isFuture = (targetYear > thisYear || (targetYear === thisYear && m > thisMonth));
      const ym = `${targetYear}-${String(m + 1).padStart(2, '0')}`;
      const isUnactivated = !isFuture && mTokens === 0 && Boolean(firstYm && ym < firstYm);
      if (!isFuture && mTokens > maxMonthTokens) {
        maxMonthTokens = mTokens;
      }
      const shortMonthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      monthsData.push({
        monthIndex: m,
        monthName: currentPanelLanguage === 'en' ? (shortMonthsEn[m] || `${m + 1}`) : `${m + 1}月`,
        tokens: mTokens,
        dates: mDates,
        isCurrent,
        isFuture,
        isUnactivated
      });
    }

    const core = globalThis.__AGContextMeterCore || {};
    const env = typeof core.resolveScaleEnvelope === 'function'
      ? core.resolveScaleEnvelope(maxMonthTokens, 'yearly')
      : { tier: '1B', label: '1B', anchor: 1e9, dCap: 58, refRings: [1e6, 10e6, 100e6, 1e9], overflowThreshold: 1e9 };
    box.setAttribute('data-scale-tier', env.tier || '');

    const createSvgNode = tag => {
      if (typeof document !== 'undefined' && typeof document.createElementNS === 'function') {
        return document.createElementNS('http://www.w3.org/2000/svg', tag);
      }
      return document.createElement(tag);
    };

    const svg = createSvgNode('svg');
    svg.setAttribute('class', 'heat-yearly-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));

    // 右侧留出同心参考环独立区域，保证窄窗不挤压或遮挡任何月份标签
    const refZoneW = Math.min(70, Math.max(52, Math.round(W * 0.11)));
    const monthsWidth = Math.max(200, W - refZoneW);
    const colW = monthsWidth / 12;
    const cy = 40;
    const labelY = H - 7;

    // 判定双门槛 Peak 徽标（活跃非零月 >= 2 且最大值 >= 10M）
    const nonFutureTokens = monthsData.filter(x => !x.isFuture).map(x => x.tokens);
    const allowPeak = typeof core.shouldShowYearlyPeakBadge === 'function'
      ? core.shouldShowYearlyPeakBadge(nonFutureTokens)
      : false;

    let rawPeakIdx = -1;
    let peakTokens = 0;
    monthsData.forEach(item => {
      if (!item.isFuture && item.tokens > peakTokens) {
        peakTokens = item.tokens;
        rawPeakIdx = item.monthIndex;
      }
    });
    const peakMonthIndex = allowPeak ? rawPeakIdx : -1;

    // 1. 先渲染右侧背景同心参考圆（1M / 10M / 100M / 1B 中匹配当前包络的物理大小）
    const refGroup = createSvgNode('g');
    refGroup.setAttribute('class', 'yearly-ref-rings');
    const refCx = monthsWidth + refZoneW / 2;
    const ringsList = Array.isArray(env.refRings) && env.refRings.length ? env.refRings : [env.anchor];
    ringsList.forEach(ringVal => {
      const rInfo = typeof core.mapBubbleDiameter === 'function'
        ? core.mapBubbleDiameter(ringVal, env)
        : { radius: 20 };
      const ringCircle = createSvgNode('circle');
      ringCircle.setAttribute('cx', String(refCx));
      ringCircle.setAttribute('cy', String(cy));
      ringCircle.setAttribute('r', rInfo.radius.toFixed(2));
      ringCircle.setAttribute('fill', 'none');
      ringCircle.setAttribute('stroke', 'rgba(148,163,184,0.28)');
      ringCircle.setAttribute('stroke-width', '1');
      ringCircle.setAttribute('stroke-dasharray', '2,2');
      refGroup.appendChild(ringCircle);
    });
    const refCaption = createSvgNode('text');
    refCaption.setAttribute('x', String(refCx));
    refCaption.setAttribute('y', String(labelY));
    refCaption.setAttribute('text-anchor', 'middle');
    refCaption.setAttribute('font-size', '9');
    refCaption.setAttribute('fill', 'var(--ag-text-muted)');
    refCaption.textContent = env.label || '';
    refGroup.appendChild(refCaption);
    svg.appendChild(refGroup);

    // 2. 渲染 12 个月气泡、状态描边与全列点击热区
    monthsData.forEach((item, idx) => {
      const cx = colW * idx + colW / 2;
      const g = createSvgNode('g');
      g.setAttribute('class', 'heat-yearly-bubble-group');
      g.setAttribute('data-month', String(item.monthIndex + 1));
      g.setAttribute('data-tokens', String(item.tokens));
      g.style.animationDelay = `${idx * 20}ms`;

      // 全列交互热区，确保 5px 零值点或极小气泡可轻松悬浮与点击
      const hitRect = createSvgNode('rect');
      hitRect.setAttribute('class', 'bubble-hit-area');
      hitRect.setAttribute('x', String(colW * idx));
      hitRect.setAttribute('y', '0');
      hitRect.setAttribute('width', String(colW));
      hitRect.setAttribute('height', String(H));
      hitRect.setAttribute('fill', 'transparent');
      g.appendChild(hitRect);

      let radius = 2.5;
      let fillCol = scale[0] || '#27272a';
      let isOverflow = false;
      if (item.isFuture) {
        radius = 8.0;
        fillCol = 'transparent';
      } else if (item.tokens > 0) {
        const bInfo = typeof core.mapBubbleDiameter === 'function'
          ? core.mapBubbleDiameter(item.tokens, env)
          : { radius: 14, diameter: 28, overflow: false };
        radius = bInfo.radius;
        isOverflow = Boolean(bInfo.overflow);
        fillCol = (typeof getContinuousHeatColor === 'function' ? getContinuousHeatColor(item.tokens, 'yearly') : null) || scale[2];
      }

      if (isOverflow) {
        const glowRing = createSvgNode('circle');
        glowRing.setAttribute('class', 'bubble-overflow-glow');
        glowRing.setAttribute('cx', String(cx));
        glowRing.setAttribute('cy', String(cy));
        glowRing.setAttribute('r', (radius + 2.5).toFixed(2));
        glowRing.setAttribute('fill', 'none');
        glowRing.setAttribute('stroke', '#E879F9');
        glowRing.setAttribute('stroke-width', '2');
        glowRing.setAttribute('opacity', '0.88');
        g.appendChild(glowRing);
      }

      const circle = createSvgNode('circle');
      circle.setAttribute('class', 'bubble-main');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', radius.toFixed(2));
      circle.setAttribute('data-diameter', (radius * 2).toFixed(2));
      circle.setAttribute('fill', fillCol);
      if (item.isUnactivated) {
        circle.setAttribute('opacity', '0.35');
      }
      circle.setAttribute('stroke', item.isFuture
        ? '#3F3F46'
        : (item.monthIndex === peakMonthIndex ? 'var(--ag-text-primary)' : 'rgba(255,255,255,0.10)'));
      circle.setAttribute('stroke-width', item.monthIndex === peakMonthIndex ? '2' : '1');

      if (item.isFuture) {
        circle.setAttribute('stroke-dasharray', '2,2');
      }

      g.appendChild(circle);

      if (item.isCurrent) {
        const activeRing = createSvgNode('circle');
        activeRing.setAttribute('class', 'bubble-current-ring');
        activeRing.setAttribute('cx', String(cx));
        activeRing.setAttribute('cy', String(cy));
        activeRing.setAttribute('r', (radius + 3.5).toFixed(2));
        activeRing.setAttribute('fill', 'none');
        activeRing.setAttribute('stroke', 'var(--ag-custom-token-accent, var(--ag-host-accent, var(--primary, #3274f6)))');
        activeRing.setAttribute('stroke-width', '1.5');
        activeRing.setAttribute('stroke-dasharray', '3,3');
        g.appendChild(activeRing);
      }

      if (item.monthIndex === peakMonthIndex && item.tokens > 0) {
        const peakBadge = createSvgNode('text');
        peakBadge.setAttribute('class', 'bubble-peak-badge');
        peakBadge.setAttribute('x', String(cx));
        peakBadge.setAttribute('y', String(Math.max(8, cy - radius - 4)));
        peakBadge.setAttribute('text-anchor', 'middle');
        peakBadge.setAttribute('font-size', '8.5');
        peakBadge.setAttribute('font-weight', '600');
        peakBadge.setAttribute('fill', 'var(--ag-custom-token-accent, var(--ag-host-accent, var(--primary, #3274f6)))');
        peakBadge.textContent = t('tokens.heat.peakBadge');
        g.appendChild(peakBadge);
      }

      const text = createSvgNode('text');
      text.setAttribute('class', 'bubble-month-lbl');
      text.setAttribute('x', String(cx));
      text.setAttribute('y', String(labelY));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', colW < 34 ? '8.5' : '10');
      text.setAttribute('fill', item.isCurrent ? 'var(--ag-text-primary)' : 'var(--ag-text-muted)');
      text.setAttribute('font-weight', item.isCurrent ? '600' : '400');
      text.textContent = item.monthName;
      g.appendChild(text);

      const showPop = () => {
        const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, item.dates, activeCostModel, {
          mode: activeCostMode,
          todayStr: formatLocalYmd(win.today)
        });
        const costStr = costAgg.totalCostUSD > 0 ? ` · ${formatUsdMetricDisplay(costAgg.totalCostUSD, { detail: true })}` : '';
        const yearMonthLabel = currentPanelLanguage === 'en' ? `${item.monthName} ${targetYear}` : `${targetYear}年${item.monthName}`;
        heatPopDate.textContent = `${yearMonthLabel}${item.isCurrent ? t('heatmap.pop.inProgress') : (item.monthIndex === peakMonthIndex ? t('heatmap.pop.peak') : '')}`;
        heatPopVal.textContent = item.tokens > 0
          ? `${fmtYi(item.tokens)} Tokens${costStr}`
          : (item.isFuture ? t('heatmap.pop.future') : (item.isUnactivated ? t('tokens.heat.unactivatedTip') : '0 Tokens'));
        heatPopDet.innerHTML = `<span>${t('heatmap.pop.monthlyDet', { avg: costAgg.dailyAverageUSD.toFixed(2), days: costAgg.activeDays })}</span>`;
        heatPopDet.style.display = 'block';

        const r = g.getBoundingClientRect ? g.getBoundingClientRect() : { left: cx, top: cy, width: radius * 2 };
        heatPop.style.left = `${r.left + (r.width || 0) / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      g.addEventListener('mouseenter', showPop);
      g.addEventListener('mouseleave', hidePopover);
      g.addEventListener('click', showPop);

      svg.appendChild(g);
    });

    box.appendChild(svg);
    updateSummaryBar('yearly', allYearDates);
  }

  // 初始化首次使用日与时间轴显示并触发后台完整历史同步
  computeTimelineWindow();
  void syncTokenHistoryFromHost();

  // 统一生成徽章、悬浮提示与速览卡片的状态数据
  function resolveDisplayStatus(d, session) {
    const ec = d?.errorClassification;
    let kind = ec?.kind || (d?.exceeded ? 'context_overflow' : d?.network ? 'network_error' : d?.error ? 'unknown' : 'none');

    // 如果没有显示分类但存在明确标志
    if (d?.exceeded) kind = 'context_overflow';

    if (kind === 'context_overflow' || d?.exceeded) {
      const sLimit = d?.serviceLimit || ec?.serviceLimit;
      const limStatus = sLimit ? t('diag.ctx.statusLim', { lim: short(sLimit) }) : '';
      const limTakeaway = sLimit ? t('diag.ctx.statusLim', { lim: fmt(sLimit) }) : '';
      return {
        kind: 'context_overflow',
        badgeText: t('diag.ctx.badge'),
        amountText: t('diag.ctx.amount'),
        keyBadgeText: t('diag.ctx.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.ctx.hover'),
        tipTitle: t('diag.ctx.tipTitle'),
        tipPct: t('diag.ctx.tipPct'),
        tipDetail: sLimit ? t('diag.ctx.tipDetailLim', { lim: fmtBubbleToken(sLimit) }) : t('diag.ctx.tipDetailDef'),
        statusText: t('diag.ctx.status', { lim: limStatus }),
        keyTakeaway: t('diag.ctx.takeaway', { lim: limTakeaway }),
        isError: true,
        isOverflow: true
      };
    }

    if (kind === 'quota_exhausted') {
      const pool = ec?.modelOrPool || d?.model || t('diag.quota.defPool');
      const resetStr = ec?.resetTimeZh ? t('diag.quota.reset', { time: ec.resetTimeZh }) : '';
      return {
        kind: 'quota_exhausted',
        badgeText: t('diag.quota.badge'),
        amountText: t('diag.quota.amount'),
        keyBadgeText: t('diag.quota.badge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.quota.hover'),
        tipTitle: t('diag.quota.tipTitle'),
        tipPct: t('diag.quota.tipPct'),
        tipDetail: t('diag.quota.tipDetail', { pool, reset: resetStr }),
        statusText: t('diag.quota.status', { pool, reset: resetStr }),
        keyTakeaway: t('diag.quota.takeaway', { pool, reset: resetStr }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'rate_limited') {
      const retryStr = ec?.retryAfterSec ? t('diag.rate.retry', { sec: ec.retryAfterSec }) : '';
      return {
        kind: 'rate_limited',
        badgeText: t('diag.rate.badge'),
        amountText: t('diag.rate.amount'),
        keyBadgeText: t('diag.rate.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.rate.hover'),
        tipTitle: t('diag.rate.tipTitle'),
        tipPct: t('diag.rate.tipPct'),
        tipDetail: t('diag.rate.tipDetail', { retry: retryStr }),
        statusText: t('diag.rate.status', { retry: retryStr }),
        keyTakeaway: t('diag.rate.takeaway', { retry: retryStr }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'network_error' || d?.network) {
      const cleanDiag = ec?.diagnostic || t('diag.net.defDiag');
      return {
        kind: 'network_error',
        badgeText: t('diag.net.badge'),
        amountText: t('diag.net.amount'),
        keyBadgeText: t('diag.net.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.net.hover'),
        tipTitle: t('diag.net.tipTitle'),
        tipPct: t('diag.net.tipPct'),
        tipDetail: t('diag.net.tipDetail', { diag: cleanDiag }),
        statusText: t('diag.net.status', { diag: cleanDiag }),
        keyTakeaway: t('diag.net.takeaway', { diag: cleanDiag }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'auth_error') {
      return {
        kind: 'auth_error',
        badgeText: t('diag.auth.badge'),
        amountText: t('diag.auth.amount'),
        keyBadgeText: t('diag.auth.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.auth.hover'),
        tipTitle: t('diag.auth.tipTitle'),
        tipPct: t('diag.auth.tipPct'),
        tipDetail: t('diag.auth.tipDetail'),
        statusText: t('diag.auth.status'),
        keyTakeaway: t('diag.auth.takeaway'),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'service_unavailable') {
      return {
        kind: 'service_unavailable',
        badgeText: t('diag.svc.badge'),
        amountText: t('diag.svc.amount'),
        keyBadgeText: t('diag.svc.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.svc.hover'),
        tipTitle: t('diag.svc.tipTitle'),
        tipPct: t('diag.svc.tipPct'),
        tipDetail: t('diag.svc.tipDetail'),
        statusText: t('diag.svc.status'),
        keyTakeaway: t('diag.svc.takeaway'),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'canceled') {
      return {
        kind: 'canceled',
        badgeText: t('diag.cancel.badge'),
        amountText: t('diag.cancel.amount'),
        keyBadgeText: t('diag.cancel.badge'),
        pillClass: 'key-pill pill-muted',
        hoverExtra: t('diag.cancel.hover'),
        tipTitle: t('diag.cancel.tipTitle'),
        tipPct: t('diag.cancel.tipPct'),
        tipDetail: t('diag.cancel.tipDetail'),
        statusText: t('diag.cancel.status'),
        keyTakeaway: t('diag.cancel.takeaway'),
        isError: false,
        isOverflow: false
      };
    }

    if (d?.error) {
      const diag = ec?.diagnostic || d.error;
      return {
        kind: 'unknown',
        badgeText: t('diag.unknown.badge'),
        amountText: t('diag.unknown.amount'),
        keyBadgeText: t('diag.unknown.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.unknown.hover'),
        tipTitle: t('diag.unknown.tipTitle'),
        tipPct: t('diag.unknown.tipPct'),
        tipDetail: t('diag.unknown.tipDetail', { diag }),
        statusText: t('diag.unknown.status', { diag }),
        keyTakeaway: t('diag.unknown.takeaway', { diag }),
        isError: true,
        isOverflow: false
      };
    }

    return {
      kind: 'none',
      badgeText: '',
      amountText: '',
      keyBadgeText: '',
      pillClass: 'key-pill pill-good',
      hoverExtra: '',
      tipTitle: '',
      tipPct: '',
      tipDetail: '',
      statusText: '',
      keyTakeaway: '',
      isError: false,
      isOverflow: false
    };
  }


// =========================================================================
// 阶段六：个人 Token 用量主页左起自然日点阵热力图引擎 (renderProfileHeatmapInto)
// =========================================================================

const OM_PROFILE_HM_STYLE_ID = 'ag-om-profile-heatmap-style';
const OM_PROFILE_HM_STORAGE_KEY = 'ag_om_profile_hm_levels_v1';

const OM_PROFILE_HM_I18N = {
  'zh-CN': {
    title: 'Token 活动',
    firstUsePrefix: '首次使用',
    rangeDay: '每天',
    rangeWeek: '每周',
    rangeMonth: '每月',
    rangeYear: '今年',
    rangeAll: '累计总量',
    less: '少',
    more: '多',
    hoverHint: '点击或悬停任意格子查看当日明细',
    paletteBtn: '色阶自定义',
    paletteReset: '恢复默认',
    paletteLevelPrefix: '档位',
    detailTotal: '总用量',
    detailInput: '新输入未缓存',
    detailCache: '缓存读取',
    detailOutput: '输出',
    detailCacheHit: '缓存命中率',
    detailCost: '估算费用',
    detailModelsTitle: '分模型消耗',
    detailNoModels: '暂无分模型明细',
    detailEmptyDay: '当日无使用记录',
    detailClose: '关闭',
    summaryDaysSuffix: '天活跃',
    summaryTotalPrefix: '区间合计',
    summaryCostPrefix: '预估费用'
  },
  'zh-TW': {
    title: 'Token 活動',
    firstUsePrefix: '首次使用',
    rangeDay: '每天',
    rangeWeek: '每週',
    rangeMonth: '每月',
    rangeYear: '今年',
    rangeAll: '累計總量',
    less: '少',
    more: '多',
    hoverHint: '點擊或懸停任意格子查看當日明細',
    paletteBtn: '色階自訂',
    paletteReset: '恢復預設',
    paletteLevelPrefix: '檔位',
    detailTotal: '總用量',
    detailInput: '新輸入未快取',
    detailCache: '快取讀取',
    detailOutput: '輸出',
    detailCacheHit: '快取命中率',
    detailCost: '估算費用',
    detailModelsTitle: '依模型消耗',
    detailNoModels: '暫無依模型明細',
    detailEmptyDay: '當日無使用記錄',
    detailClose: '關閉',
    summaryDaysSuffix: '天活躍',
    summaryTotalPrefix: '區間合計',
    summaryCostPrefix: '預估費用'
  },
  en: {
    title: 'Token Activity',
    firstUsePrefix: 'First Use',
    rangeDay: 'Daily',
    rangeWeek: 'Weekly',
    rangeMonth: 'Monthly',
    rangeYear: 'This Year',
    rangeAll: 'Cumulative',
    less: 'Less',
    more: 'More',
    hoverHint: 'Click or hover any cell to inspect daily details',
    paletteBtn: 'Scale Colors',
    paletteReset: 'Reset',
    paletteLevelPrefix: 'Level',
    detailTotal: 'Total Tokens',
    detailInput: 'Uncached Input',
    detailCache: 'Cache Read',
    detailOutput: 'Output',
    detailCacheHit: 'Cache Hit',
    detailCost: 'Estimated Cost',
    detailModelsTitle: 'By Model',
    detailNoModels: 'No per-model records',
    detailEmptyDay: 'No usage recorded on this day',
    detailClose: 'Close',
    summaryDaysSuffix: 'active days',
    summaryTotalPrefix: 'Range Total',
    summaryCostPrefix: 'Estimated Cost'
  }
};

function omHmResolveLang(lang) {
  const raw = String(lang || (typeof currentPanelLanguage !== 'undefined' ? currentPanelLanguage : 'zh-CN') || 'zh-CN').toLowerCase();
  if (raw.includes('tw') || raw.includes('hk') || raw.includes('hant')) return 'zh-TW';
  if (raw.startsWith('en')) return 'en';
  return 'zh-CN';
}

function omHmFormatYmd(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function omHmParseYmd(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function omHmAddDays(dt, delta) {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + delta);
}

function omHmShortTok(n) {
  if (typeof short === 'function') return short(n);
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function omHmFormatUsd(val) {
  const v = Number(val || 0);
  if (!Number.isFinite(v) || v <= 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function omHmLoadSavedLevels() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(OM_PROFILE_HM_STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length === 5 && arr.every(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))) {
      return arr;
    }
  } catch { }
  return null;
}

function omHmSaveLevels(levels) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (!levels) localStorage.removeItem(OM_PROFILE_HM_STORAGE_KEY);
    else localStorage.setItem(OM_PROFILE_HM_STORAGE_KEY, JSON.stringify(levels));
  } catch { }
}

function omHmEnsureStyles(containerEl) {
  if (!containerEl) return;
  const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const root = typeof containerEl.getRootNode === 'function' ? containerEl.getRootNode() : doc;
  const target = root && root.nodeType === 11 ? root : (doc.head || containerEl);
  if (!target || target.querySelector?.(`#${OM_PROFILE_HM_STYLE_ID}`)) return;
  const st = doc.createElement('style');
  st.id = OM_PROFILE_HM_STYLE_ID;
  st.setAttribute('data-om-view-style', 'profile-heatmap');
  st.textContent = `
    .om-hm-wrap {
      --om-hm-accent: var(--ag-host-accent, var(--primary, #3274f6));
      --om-hm-bg: var(--card, rgba(255, 255, 255, 0.035));
      --om-hm-surface: rgba(148, 163, 184, 0.08);
      --om-hm-border: var(--border, rgba(148, 163, 184, 0.2));
      --om-hm-text: var(--foreground, #ececef);
      --om-hm-muted: var(--muted-foreground, #94a3b8);
      --om-hm-lvl-0: rgba(148, 163, 184, 0.16);
      --om-hm-lvl-1: color-mix(in srgb, var(--om-hm-accent) 26%, transparent);
      --om-hm-lvl-2: color-mix(in srgb, var(--om-hm-accent) 48%, transparent);
      --om-hm-lvl-3: color-mix(in srgb, var(--om-hm-accent) 74%, transparent);
      --om-hm-lvl-4: var(--om-hm-accent);
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      color: var(--om-hm-text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif;
    }
    .om-hm-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .om-hm-title-group {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .om-hm-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--om-hm-text);
    }
    .om-hm-meta {
      font-size: 11.5px;
      color: var(--om-hm-muted);
      font-variant-numeric: tabular-nums;
    }
    .om-hm-ranges {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px;
      border-radius: 999px;
      border: 1px solid var(--om-hm-border);
      background: var(--om-hm-surface);
      flex-wrap: wrap;
    }
    .om-hm-range-btn {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--om-hm-muted);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 140ms ease, color 140ms ease;
    }
    .om-hm-range-btn:hover {
      color: var(--om-hm-text);
    }
    .om-hm-range-btn.is-active {
      background: color-mix(in srgb, var(--om-hm-accent) 22%, transparent);
      color: var(--om-hm-text);
      font-weight: 600;
    }
    .om-hm-scroll {
      width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 4px 2px 6px;
      box-sizing: border-box;
    }
    .om-hm-matrix {
      display: inline-flex;
      align-items: flex-end;
      gap: 5px;
      min-width: max-content;
    }
    .om-hm-day-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    .om-hm-cell {
      appearance: none;
      border: 1px solid transparent;
      padding: 2px;
      margin: 0;
      width: 16px;
      min-height: 16px;
      border-radius: 5px;
      background: var(--om-hm-lvl-0);
      cursor: pointer;
      display: flex;
      flex-direction: column-reverse;
      align-items: center;
      justify-content: center;
      gap: 2px;
      box-sizing: border-box;
      transition: transform 110ms ease, border-color 110ms ease, box-shadow 110ms ease;
    }
    .om-hm-cell:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--om-hm-accent) 65%, var(--om-hm-text));
    }
    .om-hm-cell[data-level="0"] { background: var(--om-hm-lvl-0); }
    .om-hm-cell[data-level="1"] { background: var(--om-hm-lvl-1); }
    .om-hm-cell[data-level="2"] { background: var(--om-hm-lvl-2); }
    .om-hm-cell[data-level="3"] { background: var(--om-hm-lvl-3); }
    .om-hm-cell[data-level="4"] { background: var(--om-hm-lvl-4); }
    .om-hm-cell[data-selected="true"] {
      border-color: var(--om-hm-text);
      box-shadow: 0 0 0 2px var(--om-hm-accent);
      transform: translateY(-1px);
    }
    .om-hm-dots-stack {
      display: flex;
      flex-direction: column-reverse;
      gap: 2px;
      align-items: center;
      pointer-events: none;
    }
    .om-hm-dot-pip {
      width: 12px;
      height: 12px;
      border-radius: 4px;
      background: var(--om-hm-lvl-0);
      transition: background-color 120ms ease;
    }
    .om-hm-cell--codex {
      width: auto;
      height: auto;
      padding: 3px;
      background: transparent !important;
      border-radius: 6px;
    }
    .om-hm-cell--codex[data-selected="true"] {
      background: color-mix(in srgb, var(--om-hm-accent) 14%, transparent) !important;
    }
    .om-hm-axis-lbl {
      font-size: 9.5px;
      color: var(--om-hm-muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      height: 13px;
      line-height: 13px;
    }
    .om-hm-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 11.5px;
      color: var(--om-hm-muted);
    }
    .om-hm-legend {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .om-hm-legend-swatch {
      width: 11px;
      height: 11px;
      border-radius: 3px;
      display: inline-block;
    }
    .om-hm-btn {
      appearance: none;
      border: 1px solid var(--om-hm-border);
      background: var(--om-hm-surface);
      color: var(--om-hm-text);
      border-radius: 6px;
      padding: 3px 9px;
      font-size: 11px;
      cursor: pointer;
    }
    .om-hm-btn:hover {
      border-color: var(--om-hm-accent);
    }
    .om-hm-palette-editor {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--om-hm-border);
      background: var(--om-hm-surface);
    }
    .om-hm-palette-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--om-hm-muted);
    }
    .om-hm-color-input {
      width: 24px;
      height: 20px;
      padding: 0;
      border: 1px solid var(--om-hm-border);
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
    }
    .om-hm-day-detail {
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--om-hm-accent) 42%, var(--om-hm-border));
      background: color-mix(in srgb, var(--om-hm-accent) 7%, var(--om-hm-bg));
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .om-hm-detail-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .om-hm-detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 8px;
    }
    .om-hm-detail-stat {
      padding: 7px 9px;
      border-radius: 7px;
      background: var(--om-hm-surface);
      border: 1px solid var(--om-hm-border);
    }
    .om-hm-detail-k {
      font-size: 10.5px;
      color: var(--om-hm-muted);
    }
    .om-hm-detail-v {
      font-size: 14px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: var(--om-hm-text);
      margin-top: 2px;
    }
    .om-hm-models-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .om-hm-model-chip {
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid var(--om-hm-border);
      background: var(--om-hm-surface);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
  `;
  target.appendChild(st);
}

function omHmNormalizePayload(data, opts = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const isDirectDailyMap = Object.keys(src).some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
  const dailyMap = isDirectDailyMap
    ? src
    : (src.dailyMap || src.allDailyMap || src.filteredDailyMap || {});
  const dailyInsights = src.dailyInsights
    || src.crossSessionInsights?.dailyInsights
    || {};
  const dailyModelMap = src.dailyModelMap
    || src.dailyModelMapBySource?.all
    || {};
  const modelMetaByKey = src.modelMetaByKey || {};
  const todayStr = String(
    opts.todayStr || src.todayStr || omHmFormatYmd(new Date())
  );

  // 合并所有日期的真实 token / input / cache / output / 精确 costUSD
  const merged = {};
  const allKeys = new Set([
    ...Object.keys(dailyMap || {}),
    ...Object.keys(dailyInsights || {})
  ]);
  let earliestActive = '';
  for (const dk of Array.from(allKeys).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || dk > todayStr) continue;
    const dRec = dailyMap?.[dk] || null;
    const iRec = dailyInsights?.[dk] || null;
    const input = Math.max(0, Number(dRec?.input ?? iRec?.input ?? 0));
    const cache = Math.max(0, Number(dRec?.cache ?? iRec?.cache ?? 0));
    const output = Math.max(0, Number(dRec?.output ?? iRec?.output ?? 0));
    const total = Math.max(0, Number(dRec?.total ?? iRec?.tokens ?? 0), input + cache + output);
    const exactCost = (iRec && Number.isFinite(Number(iRec.costUSD)) && Number(iRec.costUSD) > 0)
      ? Number(iRec.costUSD)
      : ((dRec && Number.isFinite(Number(dRec.costUSD)) && Number(dRec.costUSD) > 0) ? Number(dRec.costUSD) : 0);
    merged[dk] = {
      date: dk,
      total,
      input,
      cache,
      output,
      costUSD: exactCost,
      calls: Number(iRec?.calls ?? dRec?.steps ?? 0),
      sessions: Number(iRec?.sessions ?? 0)
    };
    if (total > 0 && !earliestActive) earliestActive = dk;
  }

  const explicitFirst = String(src.firstUseDate || opts.firstUseDate || '').trim();
  const validExplicitFirst = /^\d{4}-\d{2}-\d{2}$/.test(explicitFirst) && explicitFirst <= todayStr ? explicitFirst : '';
  let earliestDate = earliestActive || validExplicitFirst || todayStr;
  if (validExplicitFirst && earliestActive && validExplicitFirst < earliestActive) {
    earliestDate = validExplicitFirst;
  }

  return {
    merged,
    dailyInsights,
    dailyModelMap,
    modelMetaByKey,
    earliestDate,
    todayStr
  };
}

/**
 * 阶段六统一契约：渲染严格从左往右、自然日列粒度的个人主页 Token 活动热力图。
 * 第一列永远代表最早有记录日期，最后一列永远代表今天；支持五档视图、色阶自定义与全格点击锁定当日明细。
 */
function renderProfileHeatmapInto(containerEl, data, opts = {}) {
  if (!containerEl) return null;
  const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  if (containerEl.__omProfileHmCtrl && typeof containerEl.__omProfileHmCtrl.update === 'function') {
    containerEl.__omProfileHmCtrl.update(data, opts);
    return containerEl.__omProfileHmCtrl;
  }

  omHmEnsureStyles(containerEl);

  const validRanges = ['day', 'week', 'month', 'year', 'all'];
  const st = {
    lang: omHmResolveLang(opts.lang),
    range: validRanges.includes(opts.range) ? opts.range : 'day',
    selectedDate: null,
    paletteOpen: false,
    customLevels: Array.isArray(opts.customLevels) && opts.customLevels.length === 5
      ? opts.customLevels.slice()
      : (Array.isArray(data?.customLevels) && data.customLevels.length === 5 ? data.customLevels.slice() : omHmLoadSavedLevels()),
    data: data || {},
    opts: { ...opts },
    disposed: false,
    dayByDate: new Map()
  };

  const wrap = doc.createElement('div');
  wrap.className = 'om-hm-wrap';
  wrap.setAttribute('data-om-profile-heatmap', 'true');
  wrap.setAttribute('data-heatmap-direction', 'ltr');
  containerEl.replaceChildren(wrap);

  function applyCustomLevelVars() {
    if (Array.isArray(st.customLevels) && st.customLevels.length === 5) {
      for (let i = 0; i < 5; i++) {
        wrap.style.setProperty(`--om-hm-lvl-${i}`, st.customLevels[i]);
      }
    } else {
      for (let i = 0; i < 5; i++) {
        wrap.style.removeProperty(`--om-hm-lvl-${i}`);
      }
    }
  }

  function computeDayCost(dayRec, dateStr, norm) {
    if (!dayRec || dayRec.total <= 0) return 0;
    if (dayRec.costUSD > 0) return dayRec.costUSD;
    if (typeof calculateIntervalCost === 'function') {
      try {
        const calc = calculateIntervalCost(
          { [dateStr]: dayRec },
          [dateStr],
          'gemini-3.8-flash',
          { todayStr: norm.todayStr, dailyInsights: norm.dailyInsights }
        );
        return Number(calc?.totalCostUSD || 0);
      } catch { }
    }
    return 0;
  }

  function buildRangeDates(norm) {
    const todayDt = omHmParseYmd(norm.todayStr) || new Date();
    const earliestDt = omHmParseYmd(norm.earliestDate) || todayDt;
    let startDt = earliestDt;

    if (st.range === 'week') {
      const wStart = omHmAddDays(todayDt, -6);
      startDt = wStart > earliestDt ? wStart : earliestDt;
    } else if (st.range === 'month') {
      const mStart = omHmAddDays(todayDt, -29);
      startDt = mStart > earliestDt ? mStart : earliestDt;
    } else if (st.range === 'year') {
      const yStart = new Date(todayDt.getFullYear(), 0, 1);
      startDt = yStart > earliestDt ? yStart : earliestDt;
    }
    // day 与 all 均严格从 earliestDt（首次使用日）起自然延展至今日

    const dates = [];
    let cur = new Date(startDt.getFullYear(), startDt.getMonth(), startDt.getDate());
    const endMs = todayDt.getTime();
    let guard = 0;
    while (cur.getTime() <= endMs && guard < 1500) {
      dates.push(omHmFormatYmd(cur));
      cur = omHmAddDays(cur, 1);
      guard++;
    }
    if (!dates.length) dates.push(norm.todayStr);
    return dates;
  }

  function computeLevel(val, maxVal) {
    if (!(val > 0) || !(maxVal > 0)) return 0;
    const ratio = val / maxVal;
    if (ratio >= 0.72) return 4;
    if (ratio >= 0.44) return 3;
    if (ratio >= 0.2) return 2;
    return 1;
  }

  function renderAll() {
    if (st.disposed) return;
    applyCustomLevelVars();
    const copy = OM_PROFILE_HM_I18N[st.lang] || OM_PROFILE_HM_I18N['zh-CN'];
    const norm = omHmNormalizePayload(st.data, st.opts);
    const dates = buildRangeDates(norm);

    st.dayByDate.clear();
    let runningCum = 0;
    const series = dates.map((dk, idx) => {
      const base = norm.merged[dk] || { date: dk, total: 0, input: 0, cache: 0, output: 0, costUSD: 0, calls: 0, sessions: 0 };
      const costUSD = computeDayCost(base, dk, norm);
      runningCum += base.total;
      const rec = {
        ...base,
        colIndex: idx,
        costUSD,
        cumulativeTokens: runningCum
      };
      st.dayByDate.set(dk, rec);
      return rec;
    });

    const metricMax = st.range === 'all'
      ? Math.max(1, runningCum)
      : Math.max(1, ...series.map(d => d.total));

    const activeDaysCount = series.filter(d => d.total > 0).length;
    const rangeTokens = series.reduce((s, d) => s + d.total, 0);
    const rangeCost = series.reduce((s, d) => s + d.costUSD, 0);

    wrap.setAttribute('data-om-hm-active-range', st.range);
    wrap.setAttribute('data-earliest-date', dates[0] || norm.earliestDate);
    wrap.setAttribute('data-today-date', dates[dates.length - 1] || norm.todayStr);

    const frag = doc.createDocumentFragment();

    // 1. 顶栏：标题 + 首次使用日期 + 5 档视图切换（每天 / 每周 / 每月 / 今年 / 累计总量）
    const hdr = doc.createElement('div');
    hdr.className = 'om-hm-header';

    const titleGrp = doc.createElement('div');
    titleGrp.className = 'om-hm-title-group';
    const titleEl = doc.createElement('div');
    titleEl.className = 'om-hm-title';
    titleEl.textContent = copy.title;
    const metaEl = doc.createElement('span');
    metaEl.className = 'om-hm-meta';
    metaEl.textContent = `${copy.firstUsePrefix} ${norm.earliestDate} · ${dates[0]} → ${dates[dates.length - 1]}`;
    titleGrp.appendChild(titleEl);
    titleGrp.appendChild(metaEl);

    const rangeWrap = doc.createElement('div');
    rangeWrap.className = 'om-hm-ranges';
    rangeWrap.setAttribute('role', 'tablist');
    const rangeDefs = [
      ['day', copy.rangeDay],
      ['week', copy.rangeWeek],
      ['month', copy.rangeMonth],
      ['year', copy.rangeYear],
      ['all', copy.rangeAll]
    ];
    for (const [rk, rlbl] of rangeDefs) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `om-hm-range-btn${st.range === rk ? ' is-active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-om-hm-range', rk);
      btn.setAttribute('aria-selected', st.range === rk ? 'true' : 'false');
      btn.textContent = rlbl;
      btn.addEventListener('click', () => {
        if (st.range === rk) return;
        st.range = rk;
        st.opts.onRangeChange?.(rk);
        renderAll();
      });
      rangeWrap.appendChild(btn);
    }

    hdr.appendChild(titleGrp);
    hdr.appendChild(rangeWrap);
    frag.appendChild(hdr);

    // 2. 左起自然日点阵矩阵（每列 = 1 个自然日，首列最早，末列今天，Codex 柔和圆角点阵）
    const scrollEl = doc.createElement('div');
    scrollEl.className = 'om-hm-scroll';
    const matrixEl = doc.createElement('div');
    matrixEl.className = 'om-hm-matrix';
    matrixEl.setAttribute('data-om-hm-grid', 'true');
    matrixEl.setAttribute('data-col-count', String(series.length));

    let lastMonthTag = '';
    const hoverBar = doc.createElement('span');
    hoverBar.className = 'om-hm-meta';
    hoverBar.setAttribute('data-om-hm-hover-bar', 'true');
    hoverBar.textContent = copy.hoverHint;

    const cellByDate = new Map();
    const detailSlot = doc.createElement('div');
    detailSlot.setAttribute('data-om-hm-detail-slot', 'true');

    const renderDayDetailInPlace = () => {
      detailSlot.replaceChildren();
      if (!st.selectedDate) return;
      const selDay = st.dayByDate.get(st.selectedDate) || {
        date: st.selectedDate,
        total: 0,
        input: 0,
        cache: 0,
        output: 0,
        costUSD: 0
      };
      const detail = doc.createElement('section');
      detail.className = 'om-hm-day-detail';
      detail.setAttribute('data-om-hm-day-detail', 'true');
      detail.setAttribute('data-selected-date', selDay.date);

      const dHdr = doc.createElement('div');
      dHdr.className = 'om-hm-detail-hdr';
      const dTitle = doc.createElement('strong');
      dTitle.textContent = selDay.total > 0 ? selDay.date : `${selDay.date} · ${copy.detailEmptyDay}`;
      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'om-hm-btn';
      closeBtn.setAttribute('data-om-hm-detail-close', 'true');
      closeBtn.textContent = copy.detailClose;
      closeBtn.addEventListener('click', () => {
        syncSelectionInPlace(null);
      });
      dHdr.appendChild(dTitle);
      dHdr.appendChild(closeBtn);
      detail.appendChild(dHdr);

      const inpDenom = selDay.input + selDay.cache;
      const cachePct = inpDenom > 0 ? `${((selDay.cache / inpDenom) * 100).toFixed(1)}%` : '0%';
      const statGrid = doc.createElement('div');
      statGrid.className = 'om-hm-detail-grid';
      for (const [k, v] of [
        [copy.detailTotal, omHmShortTok(selDay.total)],
        [copy.detailInput, omHmShortTok(selDay.input)],
        [copy.detailCache, omHmShortTok(selDay.cache)],
        [copy.detailOutput, omHmShortTok(selDay.output)],
        [copy.detailCacheHit, cachePct],
        [copy.detailCost, omHmFormatUsd(selDay.costUSD)]
      ]) {
        const box = doc.createElement('div');
        box.className = 'om-hm-detail-stat';
        const kEl = doc.createElement('div');
        kEl.className = 'om-hm-detail-k';
        kEl.textContent = k;
        const vEl = doc.createElement('div');
        vEl.className = 'om-hm-detail-v';
        vEl.textContent = v;
        box.appendChild(kEl);
        box.appendChild(vEl);
        statGrid.appendChild(box);
      }
      detail.appendChild(statGrid);

      const dayModelsObj = norm.dailyModelMap?.[selDay.date] || null;
      const modelEntries = dayModelsObj && typeof dayModelsObj === 'object'
        ? Object.entries(dayModelsObj)
          .map(([mk, rec]) => {
            const meta = norm.modelMetaByKey?.[mk];
            const label = String(meta?.displayName || meta?.label || mk);
            const tot = Number(rec?.total || 0) || (Number(rec?.input || 0) + Number(rec?.cache || 0) + Number(rec?.output || 0));
            return { label, total: tot };
          })
          .filter(m => m.total > 0)
          .sort((a, b) => b.total - a.total)
        : [];

      const mTitle = doc.createElement('div');
      mTitle.className = 'om-hm-detail-k';
      mTitle.textContent = copy.detailModelsTitle;
      detail.appendChild(mTitle);

      if (modelEntries.length) {
        const mList = doc.createElement('div');
        mList.className = 'om-hm-models-list';
        for (const me of modelEntries.slice(0, 8)) {
          const chip = doc.createElement('span');
          chip.className = 'om-hm-model-chip';
          chip.textContent = `${me.label} · ${omHmShortTok(me.total)}`;
          mList.appendChild(chip);
        }
        detail.appendChild(mList);
      } else {
        const noM = doc.createElement('div');
        noM.className = 'om-hm-meta';
        noM.textContent = copy.detailNoModels;
        detail.appendChild(noM);
      }

      detailSlot.appendChild(detail);
    };

    const syncSelectionInPlace = (nextDate) => {
      st.selectedDate = nextDate || null;
      for (const [dk, cEl] of cellByDate.entries()) {
        const active = st.selectedDate === dk;
        cEl.setAttribute('data-selected', active ? 'true' : 'false');
        cEl.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      renderDayDetailInPlace();
      const detailRec = st.selectedDate ? (st.dayByDate.get(st.selectedDate) || null) : null;
      st.opts.onSelectDate?.(st.selectedDate, detailRec);
    };
    st.syncSelectionInPlace = syncSelectionInPlace;

    for (const day of series) {
      const col = doc.createElement('div');
      col.className = 'om-hm-day-col';
      col.setAttribute('data-om-hm-col', String(day.colIndex));

      const metricVal = st.range === 'all' ? day.cumulativeTokens : day.total;
      const lvl = day.total > 0 ? computeLevel(metricVal, metricMax) : 0;
      const isSel = st.selectedDate === day.date;

      const cell = doc.createElement('button');
      cell.type = 'button';
      cell.className = 'om-hm-cell om-hm-cell--codex';
      cell.setAttribute('data-om-hm-cell', 'true');
      cell.setAttribute('data-date', day.date);
      cell.setAttribute('data-col-index', String(day.colIndex));
      cell.setAttribute('data-level', String(lvl));
      cell.setAttribute('data-selected', isSel ? 'true' : 'false');
      cell.setAttribute('data-has-data', day.total > 0 ? 'true' : 'false');
      cell.setAttribute('aria-pressed', isSel ? 'true' : 'false');
      cell.title = `${day.date} · ${omHmShortTok(day.total)} tok · ${omHmFormatUsd(day.costUSD)}`;
      cell.addEventListener('click', (ev) => {
        if (ev && ev.__omHmCellHandled) return;
        if (ev) ev.__omHmCellHandled = true;
        const nextDate = st.selectedDate === day.date ? null : day.date;
        syncSelectionInPlace(nextDate);
      });
      cellByDate.set(day.date, cell);

      // Codex 风格 5 格柔和圆角点阵柱（下往上点亮，直观表达强度同时整列可点无死区）
      const stack = doc.createElement('span');
      stack.className = 'om-hm-dots-stack';
      const litPips = day.total > 0 ? Math.max(1, lvl + 1) : 0;
      for (let p = 0; p < 5; p++) {
        const pip = doc.createElement('span');
        pip.className = 'om-hm-dot-pip';
        if (p < litPips) {
          const pipLvl = Math.min(4, Math.max(1, p + 1));
          pip.style.background = `var(--om-hm-lvl-${pipLvl})`;
        } else {
          pip.style.background = 'var(--om-hm-lvl-0)';
        }
        stack.appendChild(pip);
      }
      cell.appendChild(stack);

      const mTag = day.date.slice(0, 7);
      const axis = doc.createElement('span');
      axis.className = 'om-hm-axis-lbl';
      if (day.colIndex === 0 || mTag !== lastMonthTag || day.colIndex === series.length - 1) {
        axis.textContent = day.date.slice(5);
        lastMonthTag = mTag;
      } else {
        axis.textContent = '';
      }

      col.appendChild(cell);
      col.appendChild(axis);
      matrixEl.appendChild(col);
    }

    // 事件委托在网格根上：原地更新选中态与当日明细，不销毁格子 DOM 引用与焦点
    matrixEl.addEventListener('click', (ev) => {
      if (ev && ev.__omHmCellHandled) return;
      const targetCell = ev?.target?.closest?.('[data-om-hm-cell="true"]');
      if (!targetCell) return;
      const dateStr = targetCell.getAttribute('data-date');
      if (!dateStr) return;
      if (ev) ev.__omHmCellHandled = true;
      const nextDate = st.selectedDate === dateStr ? null : dateStr;
      syncSelectionInPlace(nextDate);
    });
    matrixEl.addEventListener('mouseover', (ev) => {
      const targetCell = ev?.target?.closest?.('[data-om-hm-cell="true"]');
      if (!targetCell) return;
      const dk = targetCell.getAttribute('data-date');
      const d = dk ? st.dayByDate.get(dk) : null;
      if (d) {
        hoverBar.textContent = `${d.date} · ${omHmShortTok(d.total)} tok · ${omHmFormatUsd(d.costUSD)}`;
      }
    });
    matrixEl.addEventListener('mouseleave', () => {
      hoverBar.textContent = copy.hoverHint;
    });

    scrollEl.appendChild(matrixEl);
    frag.appendChild(scrollEl);

    // 3. 底部汇总 + 悬浮提示 + 5 档图例 + 色阶自定义入口
    const foot = doc.createElement('div');
    foot.className = 'om-hm-footer';
    const footLeft = doc.createElement('div');
    footLeft.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;';
    const sumSpan = doc.createElement('span');
    sumSpan.textContent = `${copy.summaryTotalPrefix} ${omHmShortTok(rangeTokens)} · ${copy.summaryCostPrefix} ${omHmFormatUsd(rangeCost)} · ${activeDaysCount} ${copy.summaryDaysSuffix}`;
    footLeft.appendChild(sumSpan);
    footLeft.appendChild(hoverBar);

    const footRight = doc.createElement('div');
    footRight.style.cssText = 'display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;';
    const legend = doc.createElement('span');
    legend.className = 'om-hm-legend';
    const lessTxt = doc.createElement('span');
    lessTxt.textContent = copy.less;
    legend.appendChild(lessTxt);
    for (let l = 0; l < 5; l++) {
      const sw = doc.createElement('span');
      sw.className = 'om-hm-legend-swatch';
      sw.style.background = `var(--om-hm-lvl-${l})`;
      legend.appendChild(sw);
    }
    const moreTxt = doc.createElement('span');
    moreTxt.textContent = copy.more;
    legend.appendChild(moreTxt);
    footRight.appendChild(legend);

    if (st.opts.showPaletteEditor !== false) {
      const palBtn = doc.createElement('button');
      palBtn.type = 'button';
      palBtn.className = 'om-hm-btn';
      palBtn.setAttribute('data-om-hm-palette-toggle', 'true');
      palBtn.textContent = copy.paletteBtn;
      palBtn.addEventListener('click', () => {
        st.paletteOpen = !st.paletteOpen;
        renderAll();
      });
      footRight.appendChild(palBtn);
    }

    foot.appendChild(footLeft);
    foot.appendChild(footRight);
    frag.appendChild(foot);

    // 4. 可折叠 5 档色阶自定义面板
    if (st.paletteOpen) {
      const defaults = ['#27272a', '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa'];
      const curLvls = Array.isArray(st.customLevels) && st.customLevels.length === 5 ? st.customLevels : defaults;
      const editor = doc.createElement('div');
      editor.className = 'om-hm-palette-editor';
      editor.setAttribute('data-om-hm-palette-editor', 'true');
      for (let i = 0; i < 5; i++) {
        const item = doc.createElement('label');
        item.className = 'om-hm-palette-item';
        const lbl = doc.createElement('span');
        lbl.textContent = `${copy.paletteLevelPrefix} ${i}`;
        const inp = doc.createElement('input');
        inp.type = 'color';
        inp.className = 'om-hm-color-input';
        inp.value = curLvls[i];
        inp.addEventListener('input', () => {
          const next = (Array.isArray(st.customLevels) && st.customLevels.length === 5 ? st.customLevels : defaults).slice();
          next[i] = inp.value;
          st.customLevels = next;
          omHmSaveLevels(next);
          applyCustomLevelVars();
          st.opts.onCustomLevelsChange?.(next.slice());
        });
        item.appendChild(lbl);
        item.appendChild(inp);
        editor.appendChild(item);
      }
      const resetBtn = doc.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'om-hm-btn';
      resetBtn.textContent = copy.paletteReset;
      resetBtn.addEventListener('click', () => {
        st.customLevels = null;
        omHmSaveLevels(null);
        applyCustomLevelVars();
        st.opts.onCustomLevelsChange?.(null);
        renderAll();
      });
      editor.appendChild(resetBtn);
      frag.appendChild(editor);
    }

    // 5. 选中日期的当日明细槽位（原地更新，不销毁格子 DOM）
    renderDayDetailInPlace();
    frag.appendChild(detailSlot);

    wrap.replaceChildren(frag);
  }

  function update(nextData, nextOpts = {}) {
    if (st.disposed) return;
    if (nextData !== undefined) st.data = nextData || {};
    if (nextOpts && typeof nextOpts === 'object') {
      st.opts = { ...st.opts, ...nextOpts };
      if (nextOpts.lang) st.lang = omHmResolveLang(nextOpts.lang);
      if (validRanges.includes(nextOpts.range)) st.range = nextOpts.range;
      if (Array.isArray(nextOpts.customLevels) && nextOpts.customLevels.length === 5) {
        st.customLevels = nextOpts.customLevels.slice();
      }
    }
    renderAll();
  }

  function setRange(rangeKey) {
    if (st.disposed || !validRanges.includes(rangeKey)) return;
    st.range = rangeKey;
    st.opts.onRangeChange?.(rangeKey);
    renderAll();
  }

  function setLang(nextLang) {
    if (st.disposed) return;
    st.lang = omHmResolveLang(nextLang);
    renderAll();
  }

  function getSelectedDate() {
    return st.selectedDate;
  }

  function clearSelection() {
    if (st.disposed) return;
    if (typeof st.syncSelectionInPlace === 'function') st.syncSelectionInPlace(null);
    else {
      st.selectedDate = null;
      st.opts.onSelectDate?.(null, null);
      renderAll();
    }
  }

  function setCustomLevels(levels) {
    if (st.disposed) return;
    if (Array.isArray(levels) && levels.length === 5) {
      st.customLevels = levels.slice();
      omHmSaveLevels(st.customLevels);
    } else {
      st.customLevels = null;
      omHmSaveLevels(null);
    }
    renderAll();
  }

  function getCustomLevels() {
    return st.customLevels ? st.customLevels.slice() : null;
  }

  function destroy() {
    if (st.disposed) return;
    st.disposed = true;
    if (containerEl.__omProfileHmCtrl === handle) {
      delete containerEl.__omProfileHmCtrl;
    }
  }

  const handle = {
    update,
    setRange,
    setLang,
    getSelectedDate,
    clearSelection,
    setCustomLevels,
    getCustomLevels,
    destroy
  };

  containerEl.__omProfileHmCtrl = handle;
  renderAll();
  return handle;
}

if (typeof window !== 'undefined') {
  window.renderProfileHeatmapInto = renderProfileHeatmapInto;
}
