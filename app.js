(function () {
  'use strict';

  /* ---------------- 画布规格 ---------------- */
  const W = 1150;
  const H = 985;
  const PAD_X = 56;
  const PAD_TOP = 40;
  const MAX_HEADLINE_LINES = 4;
  const MAX_QUOTE_LINES = 3;
  const PREVIEW_SCALE = 2;

  const FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "Segoe UI", system-ui, -apple-system, sans-serif';

  // 默认日期：打开网页当日
  function todayLabel() {
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const d = new Date();
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  const DEFAULTS = {
    source: 'FakeNews',
    headline: '英伟达董事会调查发现，生成器被用于制作虚假图片，误导公众。',
    quote: '“造假的是我们自己的工具，我们对此感到震惊。”——一位明显受惊的英伟达高层说到。',
    date: todayLabel(),
    headlineSize: 54,
    quoteSize: 36,
    left: window.DEFAULT_LEFT_IMAGE || '',
    right: null
  };

  const state = {
    source: DEFAULTS.source,
    headline: DEFAULTS.headline,
    quote: DEFAULTS.quote,
    date: DEFAULTS.date,
    headlineSize: DEFAULTS.headlineSize,
    quoteSize: DEFAULTS.quoteSize,
    left: null,
    right: null
  };

  const objectUrls = { left: null, right: null };
  let lastLayout = null;

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---------------- 图片加载 ---------------- */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = src;
    });
  }

  /* ---------------- 文本换行 ---------------- */
  const CLOSING_PUNCT = new Set(Array.from('，。！？、；：）】》」』”’…%,.!?;:)】'));

  function tokenize(text) {
    const tokens = [];
    let word = '';
    const isWordChar = (ch) => /[A-Za-z0-9@#&%$'’._:+\-/]/.test(ch);
    for (const ch of String(text)) {
      if (ch === '\n') {
        if (word) { tokens.push(word); word = ''; }
        tokens.push('\n');
      } else if (isWordChar(ch)) {
        word += ch;
      } else {
        if (word) { tokens.push(word); word = ''; }
        tokens.push(ch);
      }
    }
    if (word) tokens.push(word);
    return tokens;
  }

  function wrapLines(c, text, maxWidth, maxLines, font) {
    c.font = font;
    const tokens = tokenize(text);
    const lines = [];
    let line = '';

    for (const token of tokens) {
      if (token === '\n') {
        lines.push(line);
        line = '';
        if (lines.length >= maxLines) break;
        continue;
      }
      if (!line && token === ' ') continue;

      const candidate = line + token;
      if (line && c.measureText(candidate).width > maxWidth) {
        if (CLOSING_PUNCT.has(token)) {
          // 避头点：标点允许轻微溢出，不另起一行
          line = candidate;
          continue;
        }
        lines.push(line.replace(/\s+$/, ''));
        line = token === ' ' ? '' : token;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line.replace(/\s+$/, ''));

    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] = lines[maxLines - 1].replace(/[，。、；：,.;:]$/, '') + '…';
    }
    return lines;
  }

  /* ---------------- 绘制 ---------------- */
  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.lineTo(x + w - rr, y);
    c.quadraticCurveTo(x + w, y, x + w, y + rr);
    c.lineTo(x + w, y + h - rr);
    c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    c.lineTo(x + rr, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - rr);
    c.lineTo(x, y + rr);
    c.quadraticCurveTo(x, y, x + rr, y);
    c.closePath();
  }

  // 空图位边框：预览与导出共用（导出时不带文字）
  function drawEmptyFrame(c, x, y, w, h) {
    roundRect(c, x + 4, y, w - 8, h - 4, 12);
    c.fillStyle = '#f5f6f8';
    c.fill();
    c.save();
    c.setLineDash([10, 8]);
    c.strokeStyle = '#d5d9e0';
    c.lineWidth = 3;
    c.stroke();
    c.restore();
  }

  function drawPlaceholder(c, x, y, w, h, label) {
    drawEmptyFrame(c, x, y, w, h);
    c.fillStyle = '#9aa1ab';
    c.font = '600 24px ' + FONT_STACK;
    c.textAlign = 'center';
    c.fillText(label, x + w / 2, y + h / 2 - 16);
    c.textAlign = 'left';
  }

  // 完整显示盒：图片放下后实际占据的矩形（水平垂直居中，底部预留加大留白）
  function fittedBox(img, w, availH) {
    if (!img) return null;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return { w: w, h: availH };
    const s = Math.min(w / iw, availH / ih);
    return { w: iw * s, h: ih * s };
  }

  function drawScene(c, scale, showPlaceholders) {
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);
    c.textBaseline = 'top';
    c.textAlign = 'left';

    const contentW = W - PAD_X * 2;
    let y = PAD_TOP;

    // 媒体名
    const source = state.source.trim();
    if (source) {
      c.fillStyle = '#b42318';
      c.font = '800 34px ' + FONT_STACK;
      c.fillText(source, PAD_X, y);
      y += 44 + 10;
    }

    // 标题
    const headline = state.headline.trim();
    if (headline) {
      const headlineFont = '900 ' + state.headlineSize + 'px ' + FONT_STACK;
      const lines = wrapLines(c, headline, contentW, MAX_HEADLINE_LINES, headlineFont);
      const lh = state.headlineSize * 1.26;
      c.fillStyle = '#0d0f12';
      c.font = headlineFont;
      lines.forEach((line, i) => c.fillText(line, PAD_X, y + i * lh));
      y += lines.length * lh + 18;
    }

    // 引言
    const quote = state.quote.trim();
    if (quote) {
      const quoteFont = '500 ' + state.quoteSize + 'px ' + FONT_STACK;
      const lines = wrapLines(c, quote, contentW, MAX_QUOTE_LINES, quoteFont);
      const lh = state.quoteSize * 1.62;
      c.fillStyle = '#34363b';
      c.font = quoteFont;
      lines.forEach((line, i) => c.fillText(line, PAD_X, y + i * lh));
      y += lines.length * lh + 26;
    }

    // 日期
    const date = state.date.trim();
    if (date) {
      c.fillStyle = '#111317';
      c.font = '800 30px ' + FONT_STACK;
      c.fillText(date, PAD_X, y + 2);
      y += 38 + 30;
    }

    // 配图：左右各占一半；空图位边框镜像另一侧图片的显示盒，保证对齐
    const imgTop = y;
    const imgH = Math.max(120, H - imgTop);
    lastLayout = { imgTop: imgTop, imgH: imgH, slotW: contentW / 2 };
    const halfW = contentW / 2;
    const availH = Math.max(40, imgH - Math.round(imgH * 0.12)); // 底部加大留白后的可用高度
    const rightX = PAD_X + halfW;
    const left = state.left;
    const right = state.right;

    // 空图位镜像另一侧图片盒；两侧皆空时用整个可用区
    const leftBox = fittedBox(left, halfW, availH) || fittedBox(right, halfW, availH) || { w: halfW, h: availH };
    const rightBox = fittedBox(right, halfW, availH) || fittedBox(left, halfW, availH) || { w: halfW, h: availH };

    function drawSlot(hasImg, box, x, label) {
      const dx = x + (halfW - box.w) / 2;
      const dy = imgTop + (availH - box.h) / 2;
      if (hasImg) {
        c.drawImage(hasImg, dx, dy, box.w, box.h);
      } else if (showPlaceholders) {
        drawPlaceholder(c, dx, dy, box.w, box.h, label);
      } else {
        drawEmptyFrame(c, dx, dy, box.w, box.h);
      }
    }

    drawSlot(left, leftBox, PAD_X, '左图 · 点击上传');
    drawSlot(right, rightBox, rightX, '右图 · 点击上传');
  }

  /* ---------------- 预览 ---------------- */
  function renderPreview() {
    canvas.width = W * PREVIEW_SCALE;
    canvas.height = H * PREVIEW_SCALE;
    drawScene(ctx, PREVIEW_SCALE, true);
  }

  /* ---------------- 控件绑定 ---------------- */
  function bindText(id, key) {
    const el = $(id);
    el.value = state[key];
    el.addEventListener('input', function () {
      state[key] = el.value;
      renderPreview();
    });
  }

  function bindRange(id, labelId, key) {
    const el = $(id);
    const label = $(labelId);
    el.value = String(state[key]);
    label.textContent = state[key] + ' px';
    el.addEventListener('input', function () {
      state[key] = Number(el.value);
      label.textContent = state[key] + ' px';
      renderPreview();
    });
  }

  function bindUpload(inputId, key) {
    const input = $(inputId);
    input.addEventListener('change', function () {
      const file = input.files && input.files[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) return;
      const url = URL.createObjectURL(file);
      loadImage(url)
        .then(function (img) {
          if (objectUrls[key]) URL.revokeObjectURL(objectUrls[key]);
          objectUrls[key] = url;
          openCropDialog(key, img);
        })
        .catch(function () {
          URL.revokeObjectURL(url);
          flash('这张图片无法读取，请换一张试试');
        });
      input.value = '';
    });
  }

  function clearImage(key) {
    if (objectUrls[key]) {
      URL.revokeObjectURL(objectUrls[key]);
      objectUrls[key] = null;
    }
    state[key] = null;
    setThumb(key === 'left' ? 'leftThumb' : 'rightThumb', null);
    renderPreview();
  }

  /* ---------------- 裁剪对话框 ---------------- */
  const cropModal = $('cropModal');
  const cropViewport = $('cropViewport');
  const cropImg = $('cropImg');
  const cropZoom = $('cropZoom');
  let cropSession = null;
  let cropDrag = null;

  function openCropDialog(key, img) {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    let vw = Math.min(460, window.innerWidth - 88);
    let vh = vw * ih / iw;
    if (vh > 400) { vh = 400; vw = vh * iw / ih; }
    // 视口比例与图片一致：默认完整显示整张图，缩放后才进入裁切
    const s0 = vw / iw;
    cropSession = { key: key, img: img, vw: vw, vh: vh, s0: s0, zoom: 1, ox: 0, oy: 0 };
    cropZoom.value = '100';
    cropViewport.style.width = Math.round(vw) + 'px';
    cropViewport.style.height = Math.round(vh) + 'px';
    cropImg.src = img.src;
    cropModal.hidden = false;
    applyCropTransform();
  }

  function closeCrop() {
    cropModal.hidden = true;
    cropSession = null;
    cropDrag = null;
  }

  function applyCropTransform() {
    const s = cropSession;
    if (!s) return;
    const scale = s.s0 * s.zoom;
    const iw = s.img.naturalWidth;
    const ih = s.img.naturalHeight;
    s.ox = clamp(s.ox, -Math.max(0, (iw * scale - s.vw) / 2), Math.max(0, (iw * scale - s.vw) / 2));
    s.oy = clamp(s.oy, -Math.max(0, (ih * scale - s.vh) / 2), Math.max(0, (ih * scale - s.vh) / 2));
    const tx = (s.vw - iw * scale) / 2 + s.ox;
    const ty = (s.vh - ih * scale) / 2 + s.oy;
    cropImg.style.width = (iw * scale) + 'px';
    cropImg.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
  }

  cropViewport.addEventListener('pointerdown', function (e) {
    if (!cropSession) return;
    e.preventDefault();
    cropDrag = { x: e.clientX, y: e.clientY, ox: cropSession.ox, oy: cropSession.oy };
    cropViewport.setPointerCapture(e.pointerId);
  });

  cropViewport.addEventListener('pointermove', function (e) {
    if (!cropSession || !cropDrag) return;
    cropSession.ox = cropDrag.ox + (e.clientX - cropDrag.x);
    cropSession.oy = cropDrag.oy + (e.clientY - cropDrag.y);
    applyCropTransform();
  });

  ['pointerup', 'pointercancel'].forEach(function (t) {
    cropViewport.addEventListener(t, function () { cropDrag = null; });
  });

  cropZoom.addEventListener('input', function () {
    if (!cropSession) return;
    cropSession.zoom = Number(cropZoom.value) / 100;
    applyCropTransform();
  });

  $('cropConfirm').addEventListener('click', function () {
    const s = cropSession;
    if (!s) return;
    const scale = s.s0 * s.zoom;
    const iw = s.img.naturalWidth;
    const ih = s.img.naturalHeight;
    const sx = (iw * scale - s.vw) / 2 - s.ox;
    const sy = (ih * scale - s.vh) / 2 - s.oy;
    const sw = s.vw / scale;
    const sh = s.vh / scale;
    const outScale = Math.min(1, 1400 / Math.max(sw, sh));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * outScale));
    out.height = Math.max(1, Math.round(sh * outScale));
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(s.img, sx, sy, sw, sh, 0, 0, out.width, out.height);
    finishCrop(s.key, out.toDataURL('image/jpeg', 0.86));
  });

  $('cropCancel').addEventListener('click', function () {
    const s = cropSession;
    if (s && objectUrls[s.key]) {
      URL.revokeObjectURL(objectUrls[s.key]);
      objectUrls[s.key] = null;
    }
    closeCrop();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !cropModal.hidden) closeCrop();
  });

  function finishCrop(key, dataUrl) {
    loadImage(dataUrl)
      .then(function (img) {
        if (objectUrls[key]) {
          URL.revokeObjectURL(objectUrls[key]);
          objectUrls[key] = null;
        }
        state[key] = img;
        setThumb(key === 'left' ? 'leftThumb' : 'rightThumb', dataUrl);
        closeCrop();
        renderPreview();
        flash('图片已按所选范围应用');
      })
      .catch(function () {
        closeCrop();
        flash('图片处理失败，请重试');
      });
  }

  function applyDefaults() {
    state.source = DEFAULTS.source;
    state.headline = DEFAULTS.headline;
    state.quote = DEFAULTS.quote;
    state.date = DEFAULTS.date;
    state.headlineSize = DEFAULTS.headlineSize;
    state.quoteSize = DEFAULTS.quoteSize;

    $('source').value = state.source;
    $('headline').value = state.headline;
    $('quote').value = state.quote;
    $('date').value = state.date;
    $('headlineSize').value = String(state.headlineSize);
    $('headlineSizeVal').textContent = state.headlineSize + ' px';
    $('quoteSize').value = String(state.quoteSize);
    $('quoteSizeVal').textContent = state.quoteSize + ' px';

    Object.keys(objectUrls).forEach(function (key) {
      if (objectUrls[key]) {
        URL.revokeObjectURL(objectUrls[key]);
        objectUrls[key] = null;
      }
    });

    return loadDefaultImages();
  }

  function setThumb(id, src) {
    const img = $(id);
    const box = img.parentElement;
    if (src) {
      img.src = src;
      if (box) box.classList.add('has-image');
    } else {
      img.removeAttribute('src');
      if (box) box.classList.remove('has-image');
    }
  }

  function loadDefaultImages() {
    if (!DEFAULTS.left) {
      state.left = null;
      state.right = null;
      setThumb('leftThumb', null);
      setThumb('rightThumb', null);
      renderPreview();
      return Promise.resolve();
    }
    const rightTask = DEFAULTS.right ? loadImage(DEFAULTS.right) : Promise.resolve(null);
    return Promise.all([loadImage(DEFAULTS.left), rightTask])
      .then(function (imgs) {
        state.left = imgs[0];
        state.right = imgs[1];
        setThumb('leftThumb', DEFAULTS.left);
        setThumb('rightThumb', DEFAULTS.right);
        renderPreview();
      })
      .catch(function () {
        state.left = null;
        state.right = null;
        setThumb('leftThumb', null);
        setThumb('rightThumb', null);
        renderPreview();
      });
  }

  /* ---------------- 导出 ---------------- */
  let flashTimer = null;
  function flash(message) {
    const el = $('status');
    el.textContent = message;
    el.classList.add('show');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 2400);
  }

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function download() {
    const scale = Number($('scale').value) || 2;
    const out = document.createElement('canvas');
    out.width = W * scale;
    out.height = H * scale;
    drawScene(out.getContext('2d'), scale, false);

    out.toBlob(function (blob) {
      if (!blob) {
        flash('导出失败，请重试');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'meme-' + timestamp() + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      flash('已导出 ' + out.width + ' × ' + out.height + ' PNG');
    }, 'image/png');
  }

  /* ---------------- 初始化 ---------------- */
  bindText('source', 'source');
  bindText('headline', 'headline');
  bindText('quote', 'quote');
  bindText('date', 'date');
  bindRange('headlineSize', 'headlineSizeVal', 'headlineSize');
  bindRange('quoteSize', 'quoteSizeVal', 'quoteSize');
  bindUpload('leftFile', 'left');
  bindUpload('rightFile', 'right');

  $('leftClear').addEventListener('click', function () {
    clearImage('left');
    flash('已删除左图');
  });
  $('rightClear').addEventListener('click', function () {
    clearImage('right');
    flash('已删除右图');
  });

  // 点击预览图的左/右半区触发对应图片的上传
  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width * W,
      y: (e.clientY - rect.top) / rect.height * H
    };
  }

  canvas.addEventListener('click', function (e) {
    if (e.button !== 0) return;
    if (!lastLayout) return;
    const p = canvasPoint(e);
    if (p.y < lastLayout.imgTop) return;
    const key = p.x < PAD_X + lastLayout.slotW ? 'left' : 'right';
    $(key === 'left' ? 'leftFile' : 'rightFile').click();
  });

  canvas.addEventListener('mousemove', function (e) {
    if (!lastLayout) return;
    const p = canvasPoint(e);
    canvas.style.cursor = p.y >= lastLayout.imgTop ? 'pointer' : 'default';
  });

  $('download').addEventListener('click', download);
  $('reset').addEventListener('click', function () {
    applyDefaults().then(function () { flash('已恢复默认内容'); });
  });

  // 字体就绪后重绘一次，避免首屏字体回退
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(renderPreview);
  }

  renderPreview();

  // 默认左图内嵌在 HTML 的隐藏 img 中（data URL），直接复用，避免额外的网络请求
  const bootPortrait = document.getElementById('bootPortrait');
  const bootSrc = bootPortrait ? bootPortrait.getAttribute('src') : '';
  if (bootPortrait && bootSrc && bootSrc !== '__BOOT_PORTRAIT__') {
    DEFAULTS.left = bootSrc;
    const usePortrait = function () {
      if (!bootPortrait.naturalWidth) return;
      state.left = bootPortrait;
      setThumb('leftThumb', bootSrc);
      renderPreview();
    };
    if (bootPortrait.complete && bootPortrait.naturalWidth) {
      usePortrait();
    } else {
      bootPortrait.addEventListener('load', usePortrait, { once: true });
    }
  } else {
    loadDefaultImages();
  }
})();
