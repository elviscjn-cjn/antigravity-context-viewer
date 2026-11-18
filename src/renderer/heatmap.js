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
    const sig = `${win.firstStr}:${formatLocalYmd(win.winStart)}:${Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length}:${cumLinkedDailyDate || ''}`;
    if (!forceRebuild && colsBox.children.length > 0 && colsBox.getAttribute('data-sig') === sig) return;

    colsBox.replaceChildren();
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

    const monthMarkers = [];
    let lastM = -1;
    let lastCol = -10;

    for (let c = 0; c < 52; c++) {
      const col = document.createElement('div');
      col.className = 'heat-week-col';
      const slice = list.slice(c * 7, (c + 1) * 7);
      const mNum = slice[0].date.getMonth() + 1;
      if (mNum !== lastM) {
        if (c - lastCol >= 3 && 52 - c >= 2) {
          monthMarkers.push({ month: mNum, colIdx: c });
          lastCol = c;
        }
        lastM = mNum;
      }

      slice.forEach(item => {
        const cell = document.createElement('div');
        const lvl = getLvl(item.tokens);
        const isLinked = Boolean(cumLinkedDailyDate && item.key === cumLinkedDailyDate);
        cell.className = `heat-cell lvl-${lvl}${item.isFuture ? ' is-future' : ''}${item.isUnactivated ? ' is-unactivated' : ''}${item.isToday ? ' is-today' : ''}${isLinked ? ' is-cum-linked' : ''}`;
        if (item.tokens > 0 && typeof getContinuousHeatColor === 'function') {
          const contCol = getContinuousHeatColor(item.tokens, 'heat');
          if (contCol) {
            cell.style.backgroundColor = contCol;
            cell.setAttribute('data-heat-color', contCol);
          }
        }
        cell.setAttribute('data-date', item.key);
        cell.setAttribute('data-tokens', String(item.tokens));

        const showPop = () => {
          const d = item.date;
          const dateLabel = currentPanelLanguage === 'en'
            ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            : (currentPanelLanguage === 'zh-TW'
              ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
              : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`);
          heatPopDate.textContent = `${dateLabel}${item.isToday ? t('heat.today') : (item.key === win.firstStr ? t('heat.firstUse') : '')}`;
          const costInfo = getDailyModelCost(item.rec, item.key, activeCostModel, { mode: activeCostMode });
          const costStr = costInfo.costUSD > 0 ? ` · ${formatUsdMetricDisplay(costInfo.costUSD, { detail: true })}` : '';
          heatPopVal.textContent = item.tokens > 0
            ? `${fmtYi(item.tokens)} Tokens${costStr}`
            : (item.isFuture ? t('heat.future') : (item.isUnactivated ? t('tokens.heat.unactivatedTip') : '0 Tokens'));
          if (item.rec) {
            heatPopDet.innerHTML = `
              <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(item.rec.input)}</span><span class="pop-det-trans">${t('heat.prompt')}</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(item.rec.output)}</span><span class="pop-det-trans">${t('heat.output')}</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(item.rec.cache)}</span><span class="pop-det-trans">${t('heat.cache')}</span></div>
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
        cell.addEventListener('click', showPop);

        col.appendChild(cell);
      });
      colsBox.appendChild(col);
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
    const segPaletteDark = ['#4c1d95', '#5b21b6', '#6d28d9', '#7c3aed'];
    const segPaletteLight = ['#7c3aed', '#6d28d9', '#8b5cf6', '#5b21b6'];
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
          ? (isLight ? '#7c3aed' : '#9333ea')
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

      const cell = document.createElement('div');
      cell.className = `heat-month-cell heat-cell lvl-${lvl}${isFuture ? ' is-future' : ''}${isUnactivated ? ' is-unactivated' : ''}${isToday ? ' is-today' : ''}`;
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
      cell.addEventListener('click', showPop);

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
        activeRing.setAttribute('stroke', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
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
        peakBadge.setAttribute('fill', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
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

