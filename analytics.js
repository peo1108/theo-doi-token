// Phần tính toán dùng chung cho server (Node) và dashboard (trình duyệt).
// Mỗi dòng (row) là một lượt trả lời:
//   { t, model, project, session, agent, chain, effort, fast, i, o, w5, w1, cr, th }
//   i = input, o = output, w5/w1 = ghi cache 5 phút / 1 giờ, cr = đọc cache, th = thinking (nằm trong o)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Analytics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const WINDOW = 5 * HOUR;
  const TOKEN_KEYS = ['i', 'o', 'w5', 'w1', 'cr'];

  const pad = (n) => String(n).padStart(2, '0');
  const floorHour = (t) => { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); };
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const startOfWeek = (t) => { // thứ Hai 00:00
    const d = new Date(startOfDay(t));
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  };
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayStartOfKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

  // ---------- giá ----------

  function fullPrice(p) {
    return {
      input: p.input,
      output: p.output,
      cacheWrite5m: p.cacheWrite5m != null ? p.cacheWrite5m : p.input * 1.25,
      cacheWrite1h: p.cacheWrite1h != null ? p.cacheWrite1h : p.input * 2,
      cacheRead: p.cacheRead,
    };
  }

  function pricing(meta) {
    const fastK = meta.fastMultiplier || 2;
    const models = meta.models.map((m) => ({ ...m, price: fullPrice(m.price) }));
    const cache = {};

    // khớp tiền tố dài nhất: claude-opus-5-5 thắng claude-opus-5
    function modelOf(rawId) {
      if (cache[rawId]) return cache[rawId];
      let best = null, bestLen = -1;
      for (const m of models) {
        for (const p of m.match) {
          const hit = rawId === p || rawId.startsWith(p + '-') || rawId.startsWith(p + '[');
          if (hit && p.length > bestLen) { best = m; bestLen = p.length; }
        }
      }
      if (!best) {
        best = {
          id: rawId, match: [rawId], name: rawId, short: rawId.replace(/^claude-/, ''),
          color: '#c9c8c4', desc: 'Chưa có giá — thêm vào models.json',
          price: fullPrice({ input: 0, output: 0, cacheRead: 0 }), unpriced: true,
        };
        models.push(best);
      }
      return (cache[rawId] = best);
    }

    function cost(r) {
      const p = modelOf(r.model).price, k = (r.fast ? fastK : 1) / 1e6;
      const c = {
        i: r.i * p.input * k,
        o: r.o * p.output * k,
        w5: r.w5 * p.cacheWrite5m * k,
        w1: r.w1 * p.cacheWrite1h * k,
        cr: r.cr * p.cacheRead * k,
      };
      c.total = c.i + c.o + c.w5 + c.w1 + c.cr;
      return c;
    }

    // tiền tiết kiệm nhờ cache = nếu số token đọc cache bị tính theo giá đầu vào
    function saving(r) {
      const p = modelOf(r.model).price;
      return r.cr * (p.input - p.cacheRead) * (r.fast ? fastK : 1) / 1e6;
    }

    // chi phí ghi lại cache so với nếu được đọc từ cache
    function rewriteExtra(r) {
      const p = modelOf(r.model).price;
      return (r.w5 * p.cacheWrite5m + r.w1 * p.cacheWrite1h - (r.w5 + r.w1) * p.cacheRead) * (r.fast ? fastK : 1) / 1e6;
    }

    return { models, modelOf, cost, saving, rewriteExtra, contextWindow: meta.contextWindow || 1e6 };
  }

  // gắn sẵn chi phí, tổng token, độ dài ngữ cảnh vào từng dòng
  function enrich(rows, P) {
    for (const r of rows) {
      r.c = P.cost(r);
      r.tok = r.i + r.o + r.w5 + r.w1 + r.cr;
      r.ctx = r.i + r.w5 + r.w1 + r.cr;
    }
    rows.sort((a, b) => a.t - b.t);
    return rows;
  }

  // ---------- cửa sổ 5 giờ ----------
  // Ước lượng: cửa sổ bắt đầu ở giờ tròn của tin nhắn đầu tiên và kéo dài 5 giờ;
  // tin nhắn sau khi cửa sổ hết hạn mở cửa sổ mới.
  function windows(rows) {
    const out = [];
    let cur = null;
    for (const r of rows) {
      if (!cur || r.t >= cur.end) {
        const start = floorHour(r.t);
        cur = { start, end: start + WINDOW, n: 0, tok: 0, cost: 0, first: r.t, last: r.t };
        out.push(cur);
      }
      cur.n++; cur.tok += r.tok; cur.cost += r.c.total; cur.last = r.t;
    }
    return out;
  }

  // Cửa sổ thật do Anthropic báo (resets_at): [resetsAt - 5h, resetsAt). Lượt trước đó vẫn chia
  // cửa sổ theo cách ước lượng để có lịch sử so sánh.
  function realWindows(rows, resetsAt) {
    const start = resetsAt - WINDOW;
    const before = rows.filter((r) => r.t < start);
    const cur = { start, end: resetsAt, n: 0, tok: 0, cost: 0, first: null, last: null, real: true };
    for (const r of rows) {
      if (r.t < start || r.t >= resetsAt) continue;
      cur.n++; cur.tok += r.tok; cur.cost += r.c.total;
      if (cur.first == null) cur.first = r.t;
      cur.last = r.t;
    }
    const ws = windows(before);
    // cửa sổ ước lượng cuối có thể chồm qua mốc mở cửa sổ thật -> cắt lại
    const last = ws[ws.length - 1];
    if (last && last.end > start) last.end = start;
    ws.push(cur);
    return ws;
  }

  // opts.resetsAt (ms, tuỳ chọn): mốc reset 5h thật của tài khoản; còn hiệu lực thì dùng thay ước lượng.
  function summary(rows, now, opts) {
    const resetsAt = opts && opts.resetsAt;
    const dayStart = startOfDay(now), weekStart = startOfWeek(now);
    const s = { now, today: 0, todayTok: 0, week: 0, d24: 0, tok24: 0, n24: 0 };
    let bc = 0, bt = 0, crH = 0, baseH = 0, nH = 0;
    for (const r of rows) {
      if (r.t >= dayStart) { s.today += r.c.total; s.todayTok += r.tok; }
      if (r.t >= weekStart) s.week += r.c.total;
      if (r.t >= now - DAY) { s.d24 += r.c.total; s.tok24 += r.tok; s.n24++; }
      if (r.t >= now - 30 * MIN) { bc += r.c.total; bt += r.tok; }
      if (r.t >= now - HOUR) { crH += r.cr; baseH += r.ctx; nH++; }
    }
    const ws = resetsAt > now ? realWindows(rows, resetsAt) : windows(rows);
    const last = ws[ws.length - 1];
    const active = last && now < last.end ? last : null;
    const past = ws.filter((w) => w !== active && w.n >= 5);
    s.windows = ws;
    s.window = active;
    s.avgWindowCost = past.length ? past.reduce((a, w) => a + w.cost, 0) / past.length : 0;
    s.maxWindowCost = past.reduce((a, w) => Math.max(a, w.cost), 0);
    s.burn = { costPerMin: bc / 30, tokPerMin: bt / 30 };
    s.projected = active ? active.cost + s.burn.costPerMin * (active.end - now) / MIN : 0;
    s.cacheHit1h = baseH ? crH / baseH : null;
    s.n1h = nH;
    return s;
  }

  // ---------- phiên & chuỗi hội thoại ----------
  // Một phiên gồm chuỗi chính (chain = '') và các chuỗi subagent (chain = agentId).
  function chains(rows) {
    const map = new Map();
    for (const r of rows) {
      const key = r.session + '|' + r.chain;
      let c = map.get(key);
      if (!c) {
        c = { key, session: r.session, chain: r.chain, agent: r.agent, project: r.project, turns: [] };
        map.set(key, c);
      }
      c.turns.push(r);
    }
    return map;
  }

  const CAUSES = {
    expired: 'Cache hết hạn (nghỉ lâu)',
    model: 'Đổi model',
    compact: 'Compact / tóm tắt',
    prefix: 'Prefix thay đổi',
  };

  // Lượt "vỡ cache": phải ghi lại >= 50% ngữ cảnh (không tính lượt đầu của chuỗi).
  function cacheBreaks(chainMap, P) {
    const out = [];
    for (const c of chainMap.values()) {
      const ttl = c.turns.some((r) => r.w1 > 0) ? HOUR : 5 * MIN;
      for (let k = 1; k < c.turns.length; k++) {
        const r = c.turns[k], prev = c.turns[k - 1];
        const w = r.w5 + r.w1;
        if (r.ctx < 20000 || w < 0.5 * r.ctx) continue;
        const gap = r.t - prev.t;
        const cause = r.ctx < prev.ctx * 0.6 ? 'compact'
          : gap > ttl ? 'expired'
          : r.model !== prev.model ? 'model'
          : 'prefix';
        out.push({
          t: r.t, session: c.session, chain: c.chain, agent: c.agent, project: c.project,
          model: r.model, tokens: w, ctx: r.ctx, gap, ttl, cause,
          extra: cause === 'compact' ? 0 : Math.max(0, P.rewriteExtra(r)),
        });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // ngữ cảnh hiện tại của các phiên đang hoạt động (chuỗi chính, có lượt trong `within` ms)
  function activeContexts(chainMap, now, within = 30 * MIN) {
    const out = [];
    for (const c of chainMap.values()) {
      if (c.chain) continue;
      const last = c.turns[c.turns.length - 1];
      if (last && last.t >= now - within) out.push({ session: c.session, project: c.project, ctx: last.ctx, t: last.t, model: last.model });
    }
    return out.sort((a, b) => b.ctx - a.ctx);
  }

  // ---------- nhiều tài khoản ----------

  // tài khoản đang dùng tại thời điểm t; `entries` đã sắp xếp tăng dần theo t.
  // t sớm hơn mục đầu tiên → coi như mục đầu tiên.
  function accountAt(entries, t) {
    if (!entries || !entries.length) return null;
    let lo = 0, hi = entries.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].t <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return entries[found < 0 ? 0 : found].id;
  }

  // hạn mức hiệu dụng từ cachedUsageUtilization của Claude Code:
  // cửa sổ đã qua mốc reset thì coi như 0%; thiếu dữ liệu (null) thì trả null.
  function effectiveUsage(usage, now) {
    const u = usage && usage.utilization;
    const bucket = (b) => {
      if (!b || b.utilization == null) return null;
      // Anthropic trả mốc reset lệch vài trăm ms mỗi lần hỏi (…59.8s, …00.1s) -> làm tròn tới phút
      // để mốc ổn định (khoá chống báo trùng, cửa sổ 5h dựa vào nó)
      const resetsAt = b.resets_at ? Math.round(Date.parse(b.resets_at) / MIN) * MIN : NaN;
      if (Number.isNaN(resetsAt)) return { pct: b.utilization, resetsAt: null };
      return { pct: resetsAt <= now ? 0 : b.utilization, resetsAt };
    };
    return {
      fiveHour: bucket(u && u.five_hour),
      sevenDay: bucket(u && u.seven_day),
      fetchedAt: (usage && usage.fetchedAtMs) ?? null,
    };
  }

  // trạng thái đăng nhập: hết hạn, sắp hết hạn (< 3 ngày), ổn, hoặc chưa biết
  function loginState(expiresAt, now) {
    if (expiresAt == null) return 'unknown';
    if (expiresAt <= now) return 'expired';
    if (expiresAt < now + 3 * DAY) return 'soon';
    return 'ok';
  }

  // gợi ý tài khoản để chuyển sang: bỏ tài khoản đang dùng, đã hết hạn đăng nhập
  // hoặc chưa có dữ liệu hạn mức; điểm thấp nhất thắng, hoà thì cửa sổ 5 giờ reset sớm hơn.
  // điểm = % cao nhất trong 5h/tuần (đã tính reset); null nếu không có số liệu
  function usageScore(usage, now) {
    const eu = effectiveUsage(usage, now);
    if (!eu.fiveHour && !eu.sevenDay) return null;
    return Math.max(eu.fiveHour ? eu.fiveHour.pct : 0, eu.sevenDay ? eu.sevenDay.pct : 0);
  }

  // Chỉ gợi ý tài khoản chưa chạm 100% và còn nhiều hạn mức hơn tài khoản đang dùng.
  function suggestAccount(accounts, activeId, now) {
    const act = (accounts || []).find((a) => a.id === activeId);
    const actScore = act ? usageScore(act.usage, now) : null;
    let best = null, bestScore = Infinity, bestReset = Infinity;
    for (const a of accounts || []) {
      if (a.id === activeId || loginState(a.loginExpiresAt, now) === 'expired') continue;
      const score = usageScore(a.usage, now);
      if (score == null || score >= 100 || (actScore != null && score >= actScore)) continue;
      const eu = effectiveUsage(a.usage, now);
      const reset = eu.fiveHour && eu.fiveHour.resetsAt != null ? eu.fiveHour.resetsAt : Infinity;
      if (score < bestScore || (score === bestScore && reset < bestReset)) {
        best = a.id; bestScore = score; bestReset = reset;
      }
    }
    return best;
  }

  return {
    MIN, HOUR, DAY, WINDOW, TOKEN_KEYS, CAUSES,
    pad, floorHour, startOfDay, startOfWeek, dayKey, dayStartOfKey,
    pricing, enrich, windows, summary, chains, cacheBreaks, activeContexts,
    accountAt, effectiveUsage, loginState, suggestAccount,
  };
});
