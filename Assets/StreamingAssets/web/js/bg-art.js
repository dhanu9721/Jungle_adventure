/**
 * Parallax / animated background art (sprites under assets/sprites/).
 */
(function (global) {
  "use strict";

  var BASE = "assets/sprites/";
  var cache = { mist: null, tree: null, leaf: null };
  var loadPending = 0;
  var loadDoneCb = null;

  var fallLeaves = [];
  var lastWindMs = 0;
  var spawnDelayLeft = 4.5;

  function onAssetResolved() {
    loadPending--;
    if (loadPending <= 0 && loadDoneCb) {
      var c = loadDoneCb;
      loadDoneCb = null;
      c();
    }
  }

  function queueImg(src, onOk) {
    loadPending++;
    var im = new Image();
    im.onload = function () {
      onOk(im);
      onAssetResolved();
    };
    im.onerror = function () {
      onOk(null);
      onAssetResolved();
    };
    im.src = src;
  }

  function drawSoftHillLayer(ctx, W, H, cameraX, timeMs, parallax, baseY, alpha, freq) {
    var t = timeMs * 0.001;
    var off = -cameraX * parallax;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(-20, H + 2);
    for (var x = -20; x <= W + 30; x += 24) {
      var wx = x + off;
      var hump =
        Math.sin(wx * freq) * 22 +
        Math.sin(wx * freq * 1.7 + t * 0.4) * 12 +
        Math.sin(wx * freq * 0.35 + 1.2) * 8;
      ctx.lineTo(x, baseY + hump);
    }
    ctx.lineTo(W + 40, H + 2);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, baseY - 50, 0, H);
    g.addColorStop(0, "rgba(52, 108, 62, 0.45)");
    g.addColorStop(0.55, "rgba(32, 78, 42, 0.5)");
    g.addColorStop(1, "rgba(14, 42, 22, 0.65)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  /**
   * Seamless horizontal tiling + stable phase offset. Parallax = scroll slower than world.
   * (Irregular gaps + mismatched wrap + camera-based sway made motion look “swimmy”.)
   */
  function drawTreeForestLayer(ctx, W, H, cameraX, tree, parallax, scaleY, baseAlpha, yBoost, phasePx) {
    if (!tree || !tree.naturalWidth) return;
    var th = H * 0.44 * scaleY;
    var tw = (tree.naturalWidth / tree.naturalHeight) * th;
    var seg = Math.max(tw * 0.8, 70);
    var off = ((-cameraX * parallax + phasePx) % seg + seg) % seg;
    ctx.save();
    ctx.globalAlpha = baseAlpha;
    for (var x = -seg + off; x < W + seg * 2; x += seg) {
      ctx.drawImage(tree, x, H - th - 40 + yBoost, tw, th);
    }
    ctx.restore();
  }

  /** Right → left; gentle downward drift so leaves “fall away” toward the left side of the screen. */
  function updateFallLeaves(dt, timeMs, W, H) {
    var mist = cache.mist;
    var leaf = cache.leaf;
    if (!leaf || !leaf.naturalWidth) return;

    spawnDelayLeft -= dt;
    if (spawnDelayLeft <= 0 && fallLeaves.length < 4) {
      fallLeaves.push({
        x: W + 25 + Math.random() * 80,
        y: H * 0.08 + Math.random() * (H * 0.26),
        vx: -(72 + Math.random() * 38),
        vyFall: 22 + Math.random() * 26,
        tOff: Math.random() * Math.PI * 2,
        rot: (Math.random() - 0.5) * 0.35,
        rotV: (Math.random() - 0.5) * 0.55,
        alpha: 1,
        lw: 14 + Math.random() * 10,
        hasMist: mist && mist.naturalWidth && Math.random() > 0.42,
      });
      spawnDelayLeft = 4 + Math.random() * 1;
    }

    for (var i = fallLeaves.length - 1; i >= 0; i--) {
      var L = fallLeaves[i];
      L.x += L.vx * dt;
      var towardLeft = 1 - Math.max(0, Math.min(1, (L.x + 50) / (W + 100)));
      L.y += L.vyFall * (0.35 + 0.65 * towardLeft * towardLeft) * dt;
      L.y += Math.sin(L.tOff + timeMs * 0.0018) * 1.2 * dt;
      L.rot += L.rotV * dt;
      if (L.x < -L.lw - 35 || L.y > H + 30) fallLeaves.splice(i, 1);
    }
  }

  function drawFallLeaves(ctx) {
    var mist = cache.mist;
    var leaf = cache.leaf;
    if (!leaf || !leaf.naturalWidth) return;

    var list = fallLeaves.slice().sort(function (a, b) {
      return a.x - b.x;
    });

    for (var j = 0; j < list.length; j++) {
      var L = list[j];
      if (L.hasMist && mist && mist.naturalWidth) {
        ctx.save();
        ctx.globalAlpha = 0.11 * Math.min(1, L.y / 90);
        var mw = 38 + L.lw * 0.65;
        var mh = 17;
        ctx.drawImage(mist, L.x + 10, L.y - 4, mw, mh);
        ctx.restore();
      }
    }

    for (var k = 0; k < list.length; k++) {
      var L2 = list[k];
      var lh = L2.lw * 1.08;
      var lw = (leaf.naturalWidth / leaf.naturalHeight) * lh;
      ctx.save();
      ctx.globalAlpha = L2.alpha * 0.9;
      ctx.translate(L2.x + lw / 2, L2.y);
      ctx.rotate(L2.rot);
      ctx.drawImage(leaf, -lw / 2, 0, lw, lh);
      ctx.restore();
    }
  }

  global.JungleBg = {
    load: function (cb) {
      cache = { mist: null, tree: null, leaf: null };
      loadDoneCb = cb || function () {};
      loadPending = 0;
      queueImg(BASE + "mist.png", function (im) {
        cache.mist = im;
      });
      queueImg(BASE + "tree.png", function (im) {
        cache.tree = im;
      });
      queueImg(BASE + "leaf.png", function (im) {
        cache.leaf = im;
      });
      if (loadPending === 0) loadDoneCb();
    },

    resetAmbient: function () {
      fallLeaves = [];
      lastWindMs = 0;
      spawnDelayLeft = 4 + Math.random() * 1;
    },

    /** Hills → three tree depths (clear parallax, seamless wrap, staggered columns). */
    drawBackLayers: function (ctx, W, H, cameraX, timeMs) {
      drawSoftHillLayer(ctx, W, H, cameraX, timeMs, 0.042, H - 175, 0.16, 0.0065);
      drawSoftHillLayer(ctx, W, H, cameraX, timeMs, 0.058, H - 158, 0.22, 0.009);

      var tree = cache.tree;
      if (tree && tree.naturalWidth) {
        var thN = H * 0.44;
        var twN = (tree.naturalWidth / tree.naturalHeight) * thN;
        var segRef = Math.max(twN * 0.8, 70);
        drawTreeForestLayer(ctx, W, H, cameraX, tree, 0.05, 0.52, 0.32, 12, segRef * 0.18);
        drawTreeForestLayer(ctx, W, H, cameraX, tree, 0.065, 0.76, 0.42, 2, segRef * 0.52);
        drawTreeForestLayer(ctx, W, H, cameraX, tree, 0.082, 1, 0.58, -8, segRef * 0.86);
      }
    },

    drawFallingLeavesAndAir: function (ctx, W, H, cameraX, timeMs, grid, cols, rows, tile) {
      var dt = lastWindMs ? Math.min(0.05, (timeMs - lastWindMs) / 1000) : 0.016;
      lastWindMs = timeMs;
      updateFallLeaves(dt, timeMs, W, H);
      drawFallLeaves(ctx);
    },

    drawMistForeground: function (ctx, W, H, cameraX, timeMs) {
      var mist = cache.mist;
      if (!mist || !mist.naturalWidth) return;
      var drift = -timeMs * 0.008 + cameraX * 0.025;
      var mh = H * 0.32;
      var mw = (mist.naturalWidth / mist.naturalHeight) * mh;
      ctx.save();
      ctx.globalAlpha = 0.1;
      for (var x = ((-drift % mw) + mw) % mw - mw; x < W + mw; x += mw * 0.8) {
        ctx.drawImage(mist, x, H - mh - 18, mw, mh);
      }
      ctx.restore();
    },
  };
})(typeof window !== "undefined" ? window : this);
