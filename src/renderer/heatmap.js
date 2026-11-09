  function renderHeatmapGrid(forceRebuild = false) {
    const colsBox = el('h-grid-cols');
    const monthsBox = el('h-months');
    if (!colsBox || !monthsBox) return;
    const win = computeTimelineWindow();
    const sig = `${win.firstStr}:${formatLocalYmd(win.winStart)}:${Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length}`;
    if (!forceRebuild && colsBox.children.length > 0 && colsBox.getAttribute('data-sig') === sig) return;

    colsBox.replaceChildren();
    monthsBox.replaceChildren();
    colsBox.setAttribute('data-sig', sig);

    const todayKey = formatLocalYmd(win.today);
    const list = [];
    for (let i = 0; i < win.totalDays; i++) {
      const d = addDays(win.winStart, i);
      const key = formatLocalYmd(d);
      const isFuture = d.getTime() > win.today.getTime();
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[key];
      list.push({ date: d, key, tokens: rec ? rec.total : 0, rec, isFuture, isToday: key === todayKey });
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
        cell.className = `heat-cell lvl-${lvl}${item.isFuture ? ' is-future' : ''}${item.isToday ? ' is-today' : ''}`;
        cell.setAttribute('data-date', item.key);
        cell.setAttribute('data-tokens', String(item.tokens));

        const showPop = () => {
          const d = item.date;
          heatPopDate.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${item.isToday ? '（今日）' : (item.key === win.firstStr ? '（首次使用）' : '')}`;
          const costInfo = getDailyModelCost(item.rec, item.key, activeCostModel, { mode: activeCostMode });
          const cny = convertToCNY(costInfo.costUSD, 'USD');
          const costStr = costInfo.costUSD > 0 ? ` · ≈ $${costInfo.costUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
          heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} Tokens${costStr}` : (item.isFuture ? '未来日期（待产生记录）' : '0 Tokens');
          if (item.rec) {
            heatPopDet.innerHTML = `
              <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(item.rec.input)}</span><span class="pop-det-trans">提示词</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(item.rec.output)}</span><span class="pop-det-trans">输出</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(item.rec.cache)}</span><span class="pop-det-trans">缓存</span></div>
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

    monthMarkers.forEach(mm => {
      const lbl = document.createElement('span');
      lbl.className = 'heat-month-item';
      lbl.style.left = `${mm.colIdx * 13}px`;
      lbl.textContent = `${mm.month}月`;
      monthsBox.appendChild(lbl);
    });

    updateSummaryBar('daily', list.map(x => x.key));
  }

  function renderHeatmapWeekly() {
    const box = el('h-weekly-box');
    if (!box) return;
    box.replaceChildren();

    const scale = getEffectiveHeatmapScale();
    const [cEmpty, c1, c2, c3, c4] = scale;
    const win = computeTimelineWindow();
    const totalWeeks = 52;
    const weeksData = [];
    let max = 1;

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
      if (sum > max) max = sum;
      weeksData.push({ sum, sDate, eDate, startKey: formatLocalYmd(sDate) });
    }

    weeksData.forEach(w => {
      const col = document.createElement('div');
      col.className = 'w-bar-col';
      col.setAttribute('data-week-start', w.startKey);
      const fill = document.createElement('div');
      fill.className = 'w-bar-fill';
      const pct = Math.max(3, (w.sum / max) * 100);
      fill.style.height = `${pct}%`;
      const lvl = getLvlForRange(w.sum, 'week', max);
      fill.style.backgroundColor = w.sum === 0 ? cEmpty : (scale[lvl] || c4);
      col.appendChild(fill);

      const showPop = () => {
        const weekDates = [];
        for (let r = 0; r < 7; r++) weekDates.push(formatLocalYmd(addDays(w.sDate, r)));
        const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, weekDates, activeCostModel, {
          mode: activeCostMode,
          todayStr: formatLocalYmd(win.today)
        });
        const cny = convertToCNY(costAgg.totalCostUSD, 'USD');
        const costStr = costAgg.totalCostUSD > 0 ? ` · ≈ $${costAgg.totalCostUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
        heatPopDate.textContent = `${w.sDate.getFullYear()}.${w.sDate.getMonth() + 1}.${w.sDate.getDate()} - ${w.eDate.getMonth() + 1}.${w.eDate.getDate()}`;
        heatPopVal.textContent = w.sum > 0 ? `${fmtYi(w.sum)} Tokens${costStr}` : '0 Tokens';
        heatPopDet.innerHTML = `<span>Weekly Total · 周累计 (折合日均 $${costAgg.dailyAverageUSD.toFixed(2)})</span>`;
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
    const cvs = el('h-cum-canvas');
    if (!cvs || !cvs.getContext) return;
    const ctx = cvs.getContext('2d');
    const rect = cvs.getBoundingClientRect ? cvs.getBoundingClientRect() : { width: 670 };
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const width = (rect.width || 670);
    const height = 100;
    cvs.width = width * dpr;
    cvs.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const win = computeTimelineWindow();
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const winStartKey = formatLocalYmd(win.winStart);
    // 计算窗口起点之前的历史滚存基数（支持跨年翻页时累计曲线连续）
    let running = 0;
    for (const [k, rec] of Object.entries(map)) {
      if (k < winStartKey && rec?.total > 0) running += rec.total;
    }

    const activeEnd = win.winEnd.getTime() > win.today.getTime() ? win.today : win.winEnd;
    const plotDays = Math.max(1, Math.floor((activeEnd.getTime() - win.winStart.getTime()) / 86400000) + 1);
    const points = [];

    for (let i = 0; i < plotDays; i++) {
      const d = addDays(win.winStart, i);
      const k = formatLocalYmd(d);
      const rec = map[k];
      if (rec) running += rec.total;
      points.push({ date: d, key: k, val: running });
    }

    const max = running || 1;
    const denom = Math.max(1, points.length - 1);
    const step = points.length === 1 ? width : (width / denom);

    const scale = getEffectiveHeatmapScale();
    const strokeColor = customColors.tokenAccent || scale[4];
    const strokeRgb = hexToRgb(normalizeHex(strokeColor)) || { r: 192, g: 132, b: 252 };
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, `rgba(${strokeRgb.r}, ${strokeRgb.g}, ${strokeRgb.b}, 0.36)`);
    grad.addColorStop(1, `rgba(${strokeRgb.r}, ${strokeRgb.g}, ${strokeRgb.b}, 0.02)`);

    ctx.beginPath();
    ctx.moveTo(0, height);
    points.forEach((pt, idx) => {
      const x = points.length === 1 ? width / 2 : idx * step;
      const y = height - (pt.val / max) * (height - 12);
      ctx.lineTo(x, y);
    });
    if (points.length === 1) {
      const y = height - (points[0].val / max) * (height - 12);
      ctx.lineTo(width, y);
    }
    ctx.lineTo(width, height);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    points.forEach((pt, idx) => {
      const x = points.length === 1 ? 0 : idx * step;
      const y = height - (pt.val / max) * (height - 12);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (points.length === 1) {
      const y = height - (points[0].val / max) * (height - 12);
      ctx.lineTo(width, y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    cvs.onmousemove = e => {
      const r = cvs.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const idx = points.length === 1 ? 0 : Math.min(points.length - 1, Math.max(0, Math.round(mouseX / step)));
      const pt = points[idx];
      const cumDates = [];
      for (const k of Object.keys(map)) {
        if (k <= pt.key) cumDates.push(k);
      }
      const costAgg = calculateIntervalCost(map, cumDates, activeCostModel, {
        mode: activeCostMode,
        todayStr: formatLocalYmd(win.today)
      });
      const cny = convertToCNY(costAgg.totalCostUSD, 'USD');
      const costStr = costAgg.totalCostUSD > 0 ? ` · ≈ $${costAgg.totalCostUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
      heatPopDate.textContent = `${pt.date.getFullYear()}年${pt.date.getMonth() + 1}月${pt.date.getDate()}日 (累计)`;
      heatPopVal.textContent = `${fmtYi(pt.val)} Tokens${costStr}`;
      heatPopDet.innerHTML = `<span>Cumulative Total · 截至当日累计 (折合日均 $${costAgg.dailyAverageUSD.toFixed(2)})</span>`;
      heatPopDet.style.display = 'block';
      heatPop.style.left = `${e.clientX}px`;
      heatPop.style.top = `${r.top + (height - (pt.val / max) * (height - 12)) - 6}px`;
      heatPop.style.opacity = '1';
    };
    cvs.onmouseleave = hidePopover;

    const allWinDates = [];
    for (let i = 0; i < win.totalDays; i++) allWinDates.push(formatLocalYmd(addDays(win.winStart, i)));
    updateSummaryBar('cum', allWinDates);
  }

  function updateSummaryBar(viewType, dateKeys = []) {
    const sumTokensEl = el('h-sum-tokens');
    const sumCostEl = el('h-sum-cost');
    const sumDailyAvgEl = el('h-sum-daily-avg');
    const sumActiveAvgEl = el('h-sum-active-avg');
    const subRatioWrapEl = el('h-sum-sub-ratio-wrap');
    const subRatioEl = el('h-sum-sub-ratio');
    if (!sumTokensEl || !sumCostEl) return;

    const win = computeTimelineWindow();
    const todayStr = formatLocalYmd(win.today);
    const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, dateKeys, activeCostModel, {
      mode: activeCostMode,
      todayStr
    });

    const cny = convertToCNY(costAgg.totalCostUSD, 'USD');
    sumTokensEl.textContent = `${fmtYi(costAgg.totalTokens)} Tokens`;
    sumCostEl.textContent = `≈ $${costAgg.totalCostUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}`;
    sumDailyAvgEl.textContent = `$${costAgg.dailyAverageUSD.toFixed(2)}`;
    sumActiveAvgEl.textContent = `$${costAgg.activeDailyAverageUSD.toFixed(2)} (${costAgg.activeDays}天)`;

    if ((viewType === 'monthly' || viewType === 'yearly') && subRatioWrapEl && subRatioEl) {
      const plan = resolveEffectivePlanStatus(ANTIGRAVITY_TOKEN_DATA.planStatus, ANTIGRAVITY_TOKEN_DATA.customPlanSettings);
      const isZeroCost = plan.isZeroExtraCost || plan.pricePaid === 0;
      if (!isZeroCost && plan.pricePaid > 0 && costAgg.totalCostUSD > 0) {
        const subMonthlyUSD = plan.currency === 'USD' ? plan.pricePaid : (plan.actualPricePaidCNY ? plan.actualPricePaidCNY / 6.72 : plan.pricePaid);
        if (subMonthlyUSD > 0) {
          const ratio = (costAgg.totalCostUSD / (viewType === 'yearly' ? subMonthlyUSD * 12 : subMonthlyUSD)).toFixed(1);
          subRatioEl.textContent = `${ratio}x 回本`;
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
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(targetYear, targetMonth, day);
      const k = formatLocalYmd(d);
      dateKeys.push(k);
      const isFuture = d.getTime() > today.getTime();
      const isToday = k === todayKey;
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
      const tokens = rec ? rec.total : 0;
      const lvl = getLvl(tokens);

      const cell = document.createElement('div');
      cell.className = `heat-month-cell heat-cell lvl-${lvl}${isFuture ? ' is-future' : ''}${isToday ? ' is-today' : ''}`;
      cell.style.width = `${bestS}px`;
      cell.style.height = `${bestS}px`;
      cell.style.backgroundColor = scale[lvl];
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
        const cny = convertToCNY(costInfo.costUSD, 'USD');
        const costStr = costInfo.costUSD > 0 ? ` · ≈ $${costInfo.costUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
        heatPopDate.textContent = `${targetYear}年${targetMonth + 1}月${day}日${isToday ? '（今日）' : ''}`;
        heatPopVal.textContent = tokens > 0 ? `${fmtYi(tokens)} Tokens${costStr}` : (isFuture ? '未来日期（待产生记录）' : '0 Tokens');
        if (rec) {
          heatPopDet.innerHTML = `
            <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(rec.input)}</span><span class="pop-det-trans">提示词</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(rec.output)}</span><span class="pop-det-trans">输出</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(rec.cache)}</span><span class="pop-det-trans">缓存</span></div>
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
    const H = 95;

    const scale = getEffectiveHeatmapScale();
    const win = computeTimelineWindow();
    const today = win.today;
    const thisYear = today.getFullYear();
    const thisMonth = today.getMonth();
    const targetYear = thisYear + heatYearOffset;

    const monthsData = [];
    const allYearDates = [];
    let maxMonthTokens = 1;

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
      if (!isFuture && mTokens > maxMonthTokens) {
        maxMonthTokens = mTokens;
      }
      monthsData.push({
        monthIndex: m,
        monthName: `${m + 1}月`,
        tokens: mTokens,
        dates: mDates,
        isCurrent,
        isFuture
      });
    }

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

    const Rmin = 6;
    const Rmax = 24;
    const colW = W / 12;
    const cy = 42;

    let peakMonthIndex = -1;
    let peakTokens = 0;
    monthsData.forEach(item => {
      if (!item.isFuture && item.tokens > peakTokens) {
        peakTokens = item.tokens;
        peakMonthIndex = item.monthIndex;
      }
    });

    monthsData.forEach((item, idx) => {
      const cx = colW * idx + colW / 2;
      const g = createSvgNode('g');
      g.setAttribute('class', 'heat-yearly-bubble-group');
      g.style.animationDelay = `${idx * 20}ms`;

      let radius = Rmin;
      if (!item.isFuture && item.tokens > 0) {
        const ratio = Math.sqrt(item.tokens / maxMonthTokens);
        radius = Rmin + ratio * (Rmax - Rmin);
      }

      const lvl = item.isFuture ? 0 : getLvlForRange(item.tokens, 'month', maxMonthTokens);
      const fillCol = item.isFuture ? 'transparent' : (scale[lvl] || scale[0]);

      const circle = createSvgNode('circle');
      circle.setAttribute('class', 'bubble-main');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(radius));
      circle.setAttribute('fill', fillCol);
      circle.setAttribute('stroke', item.isFuture ? 'rgba(255,255,255,0.18)' : (item.monthIndex === peakMonthIndex ? 'var(--ag-text-primary)' : 'rgba(255,255,255,0.08)'));
      circle.setAttribute('stroke-width', item.monthIndex === peakMonthIndex ? '2' : '1');

      if (item.isFuture) {
        circle.setAttribute('stroke-dasharray', '2,2');
      }

      g.appendChild(circle);

      if (item.isCurrent) {
        const activeRing = createSvgNode('circle');
        activeRing.setAttribute('cx', String(cx));
        activeRing.setAttribute('cy', String(cy));
        activeRing.setAttribute('r', String(radius + 4));
        activeRing.setAttribute('fill', 'none');
        activeRing.setAttribute('stroke', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
        activeRing.setAttribute('stroke-width', '1.5');
        activeRing.setAttribute('stroke-dasharray', '3,3');
        g.appendChild(activeRing);
      }

      if (item.monthIndex === peakMonthIndex && item.tokens > 0) {
        const peakBadge = createSvgNode('text');
        peakBadge.setAttribute('x', String(cx));
        peakBadge.setAttribute('y', String(cy - radius - 5));
        peakBadge.setAttribute('text-anchor', 'middle');
        peakBadge.setAttribute('font-size', '8.5');
        peakBadge.setAttribute('font-weight', '600');
        peakBadge.setAttribute('fill', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
        peakBadge.textContent = '峰值';
        g.appendChild(peakBadge);
      }

      const text = createSvgNode('text');
      text.setAttribute('x', String(cx));
      text.setAttribute('y', String(H - 12));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '10');
      text.setAttribute('fill', item.isCurrent ? 'var(--ag-text-primary)' : 'var(--ag-text-muted)');
      text.setAttribute('font-weight', item.isCurrent ? '600' : '400');
      text.textContent = item.monthName;
      g.appendChild(text);

      const showPop = () => {
        const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, item.dates, activeCostModel, {
          mode: activeCostMode,
          todayStr: formatLocalYmd(win.today)
        });
        const cny = convertToCNY(costAgg.totalCostUSD, 'USD');
        const costStr = costAgg.totalCostUSD > 0 ? ` · ≈ $${costAgg.totalCostUSD.toFixed(2)}${cny !== null ? ` (¥${cny.toFixed(2)})` : ''}` : '';
        heatPopDate.textContent = `${targetYear}年${item.monthName}${item.isCurrent ? '（进行中）' : (item.monthIndex === peakMonthIndex ? '（年度峰值）' : '')}`;
        heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} Tokens${costStr}` : (item.isFuture ? '未来月份（尚未产生用量）' : '0 Tokens');
        heatPopDet.innerHTML = `<span>Monthly Total · 折合日均 $${costAgg.dailyAverageUSD.toFixed(2)} (活跃 ${costAgg.activeDays} 天)</span>`;
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
      return {
        kind: 'context_overflow',
        badgeText: '超限',
        amountText: '服务端超限',
        keyBadgeText: '已超限',
        pillClass: 'key-pill pill-danger',
        hoverExtra: ' · 100% 已溢出',
        tipTitle: '上下文窗口（超限告警）：',
        tipPct: '100% 已用（已超出上限）',
        tipDetail: sLimit ? `已超上限，共 ${fmtBubbleToken(sLimit)} token` : '服务端已拒绝输入（超出容量上限）',
        statusText: `服务端已拒绝：输入超限${sLimit ? `（上限 ${short(sLimit)} tokens）` : ''}。本地估算不可靠，需精简或新建会话。`,
        keyTakeaway: `✖ 已超出服务端最大限制${sLimit ? `（${fmt(sLimit)} tokens）` : ''}，当前对话已被拒绝。需精简或新建会话。`,
        isError: true,
        isOverflow: true
      };
    }

    if (kind === 'quota_exhausted') {
      const pool = ec?.modelOrPool || d?.model || '当前模型';
      const resetStr = ec?.resetTimeZh ? `，预计将于 ${ec.resetTimeZh} 重置` : '';
      return {
        kind: 'quota_exhausted',
        badgeText: '额度耗尽',
        amountText: '额度耗尽',
        keyBadgeText: '额度耗尽',
        pillClass: 'key-pill pill-danger',
        hoverExtra: ' · 模型额度用尽，可切换模型',
        tipTitle: '模型额度（额度耗尽）：',
        tipPct: '当前模型配额已用尽',
        tipDetail: `${pool}额度已耗尽${resetStr}。可手动切换至其他可用模型`,
        statusText: `模型额度耗尽：${pool}额度已用尽${resetStr}。可手动切换至其他可用模型。`,
        keyTakeaway: `✖ ${pool}额度已耗尽${resetStr}。可手动切换至 Gemini 3.8 Flash 或其他可用模型继续对话。`,
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'rate_limited') {
      const retryStr = ec?.retryAfterSec ? `（建议等待 ${ec.retryAfterSec} 秒）` : '';
      return {
        kind: 'rate_limited',
        badgeText: '限流',
        amountText: '请求限流',
        keyBadgeText: '请求限流',
        pillClass: 'key-pill pill-danger',
        hoverExtra: ' · 触发频率限制，请稍候',
        tipTitle: '请求限制（请求过频）：',
        tipPct: '触发服务端频率限制（429）',
        tipDetail: `请求过于频繁${retryStr}，请稍候重试`,
        statusText: `请求频率限制：请求过于频繁，触发服务端限制（429）${retryStr}。稍候重试即可恢复。`,
        keyTakeaway: `⚠ 触发服务端请求频率限制（HTTP 429）${retryStr}，短时间内发送请求过多，稍候重试即可恢复。`,
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'network_error' || d?.network) {
      const cleanDiag = ec?.diagnostic || '连接中断或超时';
      return {
        kind: 'network_error',
        badgeText: '网络',
        amountText: '网络故障',
        keyBadgeText: '网络故障',
        pillClass: 'key-pill pill-danger',
        hoverExtra: ' · 连接异常，请检查网络',
        tipTitle: '网络连接（连接故障）：',
        tipPct: '网络连接失败或超时',
        tipDetail: `连接异常（${cleanDiag}）。请检查本地网络代理与连接`,
        statusText: `网络连接异常：${cleanDiag}。请检查本地网络代理与网络链路设置。`,
        keyTakeaway: `✖ 网络连接出现异常（${cleanDiag}）。请检查本地网络代理与链路状态。`,
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'auth_error') {
      return {
        kind: 'auth_error',
        badgeText: '认证',
        amountText: '认证失败',
        keyBadgeText: '认证异常',
        pillClass: 'key-pill pill-danger',
        hoverExtra: ' · 权限不足或登录异常',
        tipTitle: '账号权限（身份异常）：',
        tipPct: '身份认证失败或缺少权限',
        tipDetail: '身份认证失败或无权限访问，请检查账号登录状态',
        statusText: '身份认证失败或无访问权限，请检查账号登录状态或订阅权限。',
        keyTakeaway: '✖ 身份认证失败或无访问权限（401/403）。请检查账号登录状态或订阅权限。',
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'service_unavailable') {
      return {
        kind: 'service_unavailable',
        badgeText: '服务异常',
        amountText: '服务受限',
        keyBadgeText: '服务受限',
        pillClass: 'key-pill pill-danger',
        hoverExtra: ' · 服务端繁忙，请稍候',
        tipTitle: '服务端状态（服务受限）：',
        tipPct: '模型服务暂不可用或过载',
        tipDetail: '服务端暂时过载或维护中，请稍后重试',
        statusText: '模型服务暂不可用或处于高负载（503/Overloaded），请稍后重试。',
        keyTakeaway: '⚠ 服务端暂时不可用或处于高负载（503/Overloaded），请稍后重试。',
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'canceled') {
      return {
        kind: 'canceled',
        badgeText: '已取消',
        amountText: '请求取消',
        keyBadgeText: '已取消',
        pillClass: 'key-pill pill-muted',
        hoverExtra: ' · 用户中断请求',
        tipTitle: '请求状态（已取消）：',
        tipPct: '请求已被主动取消',
        tipDetail: '本次生成请求已由用户或系统主动取消',
        statusText: '本次生成请求已由用户或系统主动取消。',
        keyTakeaway: 'ℹ 本次生成请求已由用户或系统主动取消。',
        isError: false,
        isOverflow: false
      };
    }

    if (d?.error) {
      const diag = ec?.diagnostic || d.error;
      return {
        kind: 'unknown',
        badgeText: '待确认',
        amountText: '请求异常',
        keyBadgeText: '原因待确认',
        pillClass: 'key-pill pill-danger',
        hoverExtra: ' · 失败原因待确认',
        tipTitle: '请求状态（原因待确认）：',
        tipPct: '最近请求失败（原因未知）',
        tipDetail: `当前无法确认具体原因（${diag}）`,
        statusText: `最近请求遇到错误，当前无法独立确认具体原因（${diag}）。`,
        keyTakeaway: `✖ 最近请求遇到错误，当前无法独立确认具体原因（${diag}）。`,
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

