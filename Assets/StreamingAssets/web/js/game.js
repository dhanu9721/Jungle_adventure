/**
 * Jungle platformer (30 levels, 3 worlds; Level Devil extras from stage 11+) — logical height 540px; width grows on wide screens.
 * API: JungleGame.mount(opts), .unmount(), .setPaused(bool), .loadLevelIndex(i)
 */
(function (global) {
  "use strict";

  var unityWebView =
    typeof document !== "undefined" &&
    document.documentElement &&
    document.documentElement.classList.contains("unity-webview");
  var useComfortPhysics =
    unityWebView ||
    (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
  var phy = useComfortPhysics ? 0.72 : 1;

  var TILE = 40;
  var ROWS = 14;
  var GROUND = ROWS - 2;
  /** Level Devil extras (void tiles, bombs, random crumbles) only from this 0-based index onward (11th stage). */
  var DEVIL_DIFFICULTY_FROM_INDEX = 10;
  var LEVEL_H = ROWS * TILE;
  /** Base 16:9 reference; H stays at BASE_H so vertical ground/sky framing stays consistent. */
  var BASE_W = 960;
  var BASE_H = 540;
  /** W widened on wide aspect ratios; never wider than level or W_MAX. */
  var W_MAX = 2200;
  var W = BASE_W;
  var H = BASE_H;

  var COLS = 90;
  var grid = [];
  var movers = [];
  var crumble = {};
  var gemsCollected = new Set();
  var totalGems = 0;
  var LEVEL_W = COLS * TILE;
  var levelSpawn = { x: 80, y: (GROUND - 1) * TILE - 2 };
  var currentLevel = 0;

  var player = {
    x: 80,
    y: (GROUND - 1) * TILE - 2,
    w: 26,
    h: 38,
    vx: 0,
    vy: 0,
    onGround: false,
    onVine: false,
    vineAttachCol: -1,
    vineSwing: 0,
    vineSwingVel: 0,
    facing: 1,
    runT: 0,
    state: "idle",
    coyote: 0,
    jumpBuf: 0,
    alive: true,
    deathT: 0,
  };

  var cameraX = 0;
  var lives = 3;
  var levelTime = 0;
  var gameState = "playing";
  var particles = [];

  var GRAVITY = 0.5 * phy;
  var MAX_FALL = 14 * phy;
  var WALK = 3.0 * phy;
  var RUN = 5.2 * phy;
  var JUMP = 12.8 * (useComfortPhysics ? Math.min(1, phy * 1.22) : phy);
  var CLIMB_SPEED = 2.8 * phy;

  var keys = {};
  var touchInput = { left: false, right: false, jump: false, run: false, up: false, down: false };
  /** Tap-to-toggle fast run (touch). Shift keys still use hold-to-run. */
  var touchRunFast = false;
  var touchJumpSuppress = false;
  var runTouchButton = null;

  /** Pixels to translate the whole scene up so ground sits above the touch control band. */
  var viewportLiftPx = 0;

  /** Level Devil–style surprises: void tiles, bombs from the sky, random crumbles. */
  var bombs = [];
  var volatileRestores = [];
  var devilTimer = 0;

  var ctx = null;
  var canvas = null;
  var opts = null;
  var rafId = 0;
  var mounted = false;
  var paused = false;
  var lastT = 0;
  /** Unity / older WebViews: avoid AbortController on addEventListener (can throw or no-op). */
  var detachFns = [];
  var viewportResizeObserver = null;

  function clampCameraToViewport() {
    var maxCam = Math.max(0, LEVEL_W - W);
    if (cameraX > maxCam) cameraX = maxCam;
    if (cameraX < 0) cameraX = 0;
  }

  /** Match internal buffer aspect to on-screen canvas so wide devices show more world horizontally. */
  function syncCanvasViewportSize() {
    if (!canvas || !ctx) return;
    var cw, ch;
    try {
      var r = canvas.getBoundingClientRect();
      cw = r.width;
      ch = r.height;
    } catch (_) {
      return;
    }
    if (ch < 64) return;
    var aspect = cw / ch;
    var baseAspect = BASE_W / BASE_H;
    var newW, newH;
    if (aspect >= baseAspect - 0.0001) {
      newH = BASE_H;
      newW = Math.round(newH * aspect);
      if (newW < BASE_W) newW = BASE_W;
    } else {
      newW = BASE_W;
      newH = BASE_H;
    }
    newW = Math.min(newW, W_MAX, Math.max(BASE_W, LEVEL_W));
    newH = BASE_H;
    if (newW === W && newH === H && canvas.width === W && canvas.height === H) return;
    W = newW;
    H = newH;
    canvas.width = W;
    canvas.height = H;
    clampCameraToViewport();
  }

  function bindViewportResize() {
    unbindViewportResize();
    if (canvas && typeof ResizeObserver !== "undefined") {
      viewportResizeObserver = new ResizeObserver(function () {
        syncCanvasViewportSize();
      });
      viewportResizeObserver.observe(canvas);
    }
    trackAdd(window, "resize", syncCanvasViewportSize, false);
    trackAdd(window, "orientationchange", syncCanvasViewportSize, false);
  }

  function unbindViewportResize() {
    if (viewportResizeObserver) {
      try {
        viewportResizeObserver.disconnect();
      } catch (_) {}
      viewportResizeObserver = null;
    }
  }

  function trackAdd(target, type, fn, options) {
    var opt = options === undefined ? false : options;
    target.addEventListener(type, fn, opt);
    detachFns.push(function () {
      try {
        target.removeEventListener(type, fn, opt);
      } catch (_) {}
    });
  }

  /**
   * Level design: "B" = bait — draws like grass, kills like spikes (Level Devil–style fake safe tiles).
   * Combine with F (crumble), X, pits, movers, and uneven spacing so patterns do not repeat predictably.
   */
  function addVineColumn(set, setRect, GROUND_, cVine, cGrass0, cGrass1) {
    setRect(GROUND_ - 7, cGrass0, GROUND_ - 7, cGrass1, "G");
    setRect(GROUND_ - 6, cGrass0, GROUND_ - 6, cGrass1, "D");
    for (var r = GROUND_ - 6; r <= GROUND_ - 2; r++) set(r, cVine + 1, " ");
    for (r = GROUND_ - 7; r <= GROUND_ - 2; r++) set(r, cVine, "V");
  }

  function buildLevel00(grid_, COLS_, GROUND_, set, setRect) {
    setRect(GROUND_, 0, GROUND_, 14, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, 14, "D");
    setRect(GROUND_, 17, GROUND_, 24, "G");
    setRect(GROUND_ + 1, 17, ROWS - 1, 24, "D");
    set(GROUND_ - 1, 21, "X");
    setRect(GROUND_ - 2, 25, GROUND_ - 2, 27, "F");
    set(GROUND_ - 1, 28, "G");
    set(GROUND_, 28, "D");
    setRect(GROUND_ - 2, 29, GROUND_ - 2, 31, "F");
    setRect(GROUND_, 32, GROUND_, 38, "G");
    setRect(GROUND_ + 1, 32, ROWS - 1, 38, "D");
    setRect(GROUND_ - 1, 35, GROUND_ - 1, 38, "G");
    setRect(GROUND_ - 2, 37, GROUND_ - 2, 38, "G");
    setRect(GROUND_ - 7, 40, GROUND_ - 7, 47, "G");
    setRect(GROUND_ - 6, 40, GROUND_ - 6, 47, "D");
    for (var r = GROUND_ - 6; r <= GROUND_ - 2; r++) set(r, 41, " ");
    for (r = GROUND_ - 7; r <= GROUND_ - 2; r++) set(r, 40, "V");
    set(GROUND_ - 8, 42, "C");
    set(GROUND_ - 8, 45, "C");
    setRect(GROUND_ - 3, 49, GROUND_ - 3, 51, "G");
    setRect(GROUND_ - 2, 49, GROUND_ - 2, 51, "D");
    setRect(GROUND_ - 1, 53, GROUND_ - 1, 55, "F");
    set(GROUND_, 54, "X");
    setRect(GROUND_, 53, GROUND_, 53, "D");
    setRect(GROUND_, 55, GROUND_, 55, "D");
    setRect(GROUND_ + 1, 53, ROWS - 1, 55, "D");
    setRect(GROUND_, 56, GROUND_, 63, "G");
    setRect(GROUND_ + 1, 56, ROWS - 1, 63, "D");
    setRect(GROUND_, 67, GROUND_, 86, "G");
    setRect(GROUND_ + 1, 67, ROWS - 1, 86, "D");
    set(GROUND_, 52, "B");
    set(GROUND_, 74, "B");
    set(GROUND_ - 2, 66, GROUND_ - 2, 66, "F");
    set(GROUND_ - 1, 71, "X");
    set(GROUND_ - 1, 76, "X");
    setRect(GROUND_ - 3, 72, GROUND_ - 3, 74, "F");
    set(GROUND_ - 4, 73, "C");
    set(GROUND_ - 1, 5, "C");
    set(GROUND_ - 1, 20, "C");
    set(GROUND_ - 1, 60, "C");
    set(GROUND_ - 1, 83, "E");
    setRect(GROUND_, 87, GROUND_, 89, "G");
    setRect(GROUND_ + 1, 87, ROWS - 1, 89, "D");
    var mv = [
      {
        x: 64 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 64 * TILE - 8,
        x1: 67 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.38,
      },
    ];
    return { spawn: { x: 80, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel01(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) {
      set(r, 9, " ");
      set(r, 10, " ");
    }
    for (r = GROUND_; r < ROWS; r++) {
      set(r, 22, " ");
      set(r, 23, " ");
    }
    set(GROUND_ - 1, 16, "X");
    set(GROUND_, 19, "B");
    set(GROUND_, 27, "B");
    set(GROUND_ - 2, 24, GROUND_ - 2, 24, "F");
    set(GROUND_ - 1, 30, "C");
    set(GROUND_ - 1, 35, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel02(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) {
      set(r, 14, " ");
      set(r, 15, " ");
    }
    set(GROUND_, 14, "G");
    set(GROUND_ + 1, 14, "D");
    set(GROUND_ - 1, 13, "G");
    set(GROUND_ - 2, 13, "D");
    set(GROUND_ - 1, 20, "X");
    set(GROUND_ - 1, 26, "X");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, 30, "C");
    setRect(GROUND_ - 1, 31, GROUND_ - 1, 34, "G");
    setRect(GROUND_ - 2, 31, GROUND_ - 2, 34, "D");
    addVineColumn(set, setRect, GROUND_, 36, 37, 42);
    set(GROUND_ - 8, 39, "C");
    setRect(GROUND_, 43, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 43, ROWS - 1, ec, "D");
    set(GROUND_, 33, "B");
    set(GROUND_, 38, "B");
    set(GROUND_ - 2, 36, GROUND_ - 2, 36, "F");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 48, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel03(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 11; c <= 13; c++) set(r, c, " ");
    setRect(GROUND_ - 2, 18, GROUND_ - 2, 22, "F");
    setRect(GROUND_ - 1, 18, GROUND_ - 1, 22, "G");
    setRect(GROUND_, 18, GROUND_, 22, "D");
    set(GROUND_ - 3, 20, "C");
    set(GROUND_ - 1, 28, "X");
    set(GROUND_ - 1, 31, "X");
    set(GROUND_ - 1, 34, "X");
    set(GROUND_ - 1, 20, "B");
    set(GROUND_ - 2, 21, GROUND_ - 2, 21, "F");
    set(GROUND_ - 1, 10, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 45, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel04(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 20; c <= 23; c++) set(r, c, " ");
    var mv = [
      {
        x: 18 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 16 * TILE,
        x1: 24 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.58,
      },
    ];
    set(GROUND_, 11, "B");
    set(GROUND_, 26, "B");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, 30, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel05(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 15; c <= 18; c++) set(r, c, " ");
    setRect(GROUND_ - 1, 22, GROUND_ - 1, 28, "S");
    setRect(GROUND_ - 2, 24, GROUND_ - 2, 28, "S");
    setRect(GROUND_ - 3, 26, GROUND_ - 3, 28, "S");
    addVineColumn(set, setRect, GROUND_, 32, 33, 38);
    addVineColumn(set, setRect, GROUND_, 40, 41, 46);
    for (r = GROUND_ - 6; r <= GROUND_ - 2; r++) set(r, 39, " ");
    set(GROUND_ - 8, 35, "C");
    set(GROUND_ - 8, 43, "C");
    setRect(GROUND_, 47, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 47, ROWS - 1, ec, "D");
    set(GROUND_, 36, "B");
    set(GROUND_ - 2, 33, GROUND_ - 2, 33, "F");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 48, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel06(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 16; c++) set(r, c, " ");
    setRect(GROUND_ - 2, 10, GROUND_ - 2, 12, "F");
    set(GROUND_ - 1, 11, "G");
    set(GROUND_, 11, "D");
    set(GROUND_ - 3, 11, "C");
    set(GROUND_, 24, "B");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_ - 1, 26, "X");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel07(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 18; c <= 21; c++) set(r, c, " ");
    setRect(GROUND_ - 1, 10, GROUND_ - 1, 17, "S");
    setRect(GROUND_ - 2, 12, GROUND_ - 2, 17, "S");
    setRect(GROUND_ - 3, 14, GROUND_ - 3, 17, "S");
    setRect(GROUND_ - 4, 16, GROUND_ - 4, 17, "S");
    set(GROUND_ - 5, 17, "C");
    var mv = [
      {
        x: 24 * TILE - 8,
        y: (GROUND_ - 1) * TILE - 8,
        w: TILE * 2,
        h: 14,
        x0: 22 * TILE,
        x1: 30 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.22,
      },
    ];
    set(GROUND_, 24, "B");
    set(GROUND_ - 2, 19, GROUND_ - 2, 19, "F");
    set(GROUND_ - 1, 35, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel08(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    var pits = [12, 13, 28, 29, 44, 45];
    for (var r = GROUND_; r < ROWS; r++)
      for (var i = 0; i < pits.length; i += 2) {
        set(r, pits[i], " ");
        set(r, pits[i + 1], " ");
      }
    set(GROUND_ - 1, 16, "X");
    set(GROUND_ - 1, 32, "X");
    set(GROUND_ - 1, 48, "X");
    set(GROUND_, 22, "B");
    set(GROUND_, 38, "B");
    setRect(GROUND_ - 2, 36, GROUND_ - 2, 40, "F");
    set(GROUND_ - 3, 38, "C");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, 55, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 48, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel09(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, 18, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, 18, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 19; c <= 22; c++) set(r, c, " ");
    setRect(GROUND_, 23, GROUND_, 40, "G");
    setRect(GROUND_ + 1, 23, ROWS - 1, 40, "D");
    for (var r2 = GROUND_; r2 < ROWS; r2++) for (var c2 = 34; c2 <= 36; c2++) set(r2, c2, " ");
    setRect(GROUND_, 37, GROUND_, 58, "G");
    setRect(GROUND_ + 1, 37, ROWS - 1, 58, "D");
    for (var r3 = GROUND_; r3 < ROWS; r3++) for (var c3 = 50; c3 <= 52; c3++) set(r3, c3, " ");
    setRect(GROUND_, 53, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 53, ROWS - 1, ec, "D");
    set(GROUND_ - 1, 26, "X");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_ - 1, 60, "X");
    addVineColumn(set, setRect, GROUND_, 28, 29, 33);
    set(GROUND_ - 8, 31, "C");
    setRect(GROUND_ - 2, 42, GROUND_ - 2, 45, "F");
    set(GROUND_ - 3, 43, "C");
    var mv = [
      {
        x: 20 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 18 * TILE,
        x1: 25 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.42,
      },
      {
        x: 48 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 46 * TILE,
        x1: 54 * TILE - TILE * 2 + 8,
        dir: -1,
        speed: 1.28,
      },
    ];
    set(GROUND_, 47, "B");
    set(GROUND_, 58, "B");
    set(GROUND_ - 2, 51, GROUND_ - 2, 51, "F");
    set(GROUND_ - 1, 10, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 70, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel10(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    var pits = [11, 12, 24, 25, 38, 39];
    for (var r = GROUND_; r < ROWS; r++)
      for (var i = 0; i < pits.length; i += 2) {
        set(r, pits[i], " ");
        set(r, pits[i + 1], " ");
      }
    set(GROUND_, 17, "B");
    set(GROUND_ - 2, 20, GROUND_ - 2, 21, "F");
    set(GROUND_ - 1, 32, "X");
    set(GROUND_, 29, "B");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, 44, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 48, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel11(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) {
      set(r, 8, " ");
      set(r, 9, " ");
      set(r, 19, " ");
      set(r, 20, " ");
    }
    set(GROUND_, 14, "B");
    set(GROUND_ - 1, 16, "X");
    set(GROUND_ - 2, 26, GROUND_ - 2, 27, "F");
    set(GROUND_ - 1, 31, "X");
    set(GROUND_, 35, "B");
    set(GROUND_ - 1, 12, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 14 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 12 * TILE,
        x1: 20 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.45,
      },
    ];
    return { spawn: { x: 44, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel12(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 16; c <= 19; c++) set(r, c, " ");
    setRect(GROUND_ - 1, 22, GROUND_ - 1, 30, "S");
    setRect(GROUND_ - 2, 24, GROUND_ - 2, 30, "S");
    addVineColumn(set, setRect, GROUND_, 32, 33, 37);
    set(GROUND_ - 8, 35, "C");
    set(GROUND_, 40, "B");
    setRect(GROUND_, 41, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 41, ROWS - 1, ec, "D");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel13(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 12; c <= 14; c++) set(r, c, " ");
    set(GROUND_ - 1, 18, "X");
    set(GROUND_ - 2, 22, GROUND_ - 2, 24, "F");
    set(GROUND_, 26, "B");
    set(GROUND_ - 1, 10, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 46, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel14(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 18; c <= 21; c++) set(r, c, " ");
    setRect(GROUND_ - 2, 26, GROUND_ - 2, 28, "F");
    set(GROUND_ - 3, 27, "C");
    set(GROUND_, 32, "B");
    set(GROUND_ - 1, 36, "X");
    set(GROUND_ - 2, 40, GROUND_ - 2, 42, "F");
    setRect(GROUND_, 44, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 44, ROWS - 1, ec, "D");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 30 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 28 * TILE,
        x1: 38 * TILE - TILE * 2 + 8,
        dir: -1,
        speed: 1.48,
      },
    ];
    return { spawn: { x: 48, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel15(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 10; c <= 12; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 24; c2 <= 26; c2++) set(r, c2, " ");
    set(GROUND_ - 1, 20, "X");
    set(GROUND_ - 1, 34, "X");
    set(GROUND_, 16, "B");
    set(GROUND_, 30, "B");
    addVineColumn(set, setRect, GROUND_, 18, 19, 23);
    set(GROUND_ - 8, 21, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 44, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel16(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 20; c <= 24; c++) set(r, c, " ");
    setRect(GROUND_ - 2, 12, GROUND_ - 2, 16, "F");
    set(GROUND_ - 1, 14, "X");
    setRect(GROUND_ - 1, 28, GROUND_ - 1, 32, "S");
    set(GROUND_, 35, "B");
    set(GROUND_ - 2, 38, GROUND_ - 2, 39, "F");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 52, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel17(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    var pits = [14, 15, 30, 31, 46, 47];
    for (var r = GROUND_; r < ROWS; r++)
      for (var i = 0; i < pits.length; i += 2) {
        set(r, pits[i], " ");
        set(r, pits[i + 1], " ");
      }
    set(GROUND_, 22, "B");
    set(GROUND_, 38, "B");
    set(GROUND_ - 1, 26, "X");
    set(GROUND_ - 2, 40, GROUND_ - 2, 42, "F");
    set(GROUND_ - 1, 12, "C");
    set(GROUND_ - 1, 52, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 20 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 18 * TILE,
        x1: 28 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.52,
      },
    ];
    return { spawn: { x: 46, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel18(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, 22, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, 22, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 23; c <= 26; c++) set(r, c, " ");
    setRect(GROUND_, 27, GROUND_, 48, "G");
    setRect(GROUND_ + 1, 27, ROWS - 1, 48, "D");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 40; c2 <= 42; c2++) set(r, c2, " ");
    setRect(GROUND_, 49, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 49, ROWS - 1, ec, "D");
    set(GROUND_ - 1, 32, "X");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_, 36, "B");
    set(GROUND_, 54, "B");
    addVineColumn(set, setRect, GROUND_, 34, 35, 39);
    set(GROUND_ - 8, 37, "C");
    set(GROUND_ - 1, 10, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 52, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel19(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 16; c <= 19; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 34; c2 <= 37; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 54; c3 <= 57; c3++) set(r, c3, " ");
    set(GROUND_ - 1, 24, "X");
    set(GROUND_ - 1, 42, "X");
    set(GROUND_ - 1, 62, "X");
    set(GROUND_, 28, "B");
    set(GROUND_, 48, "B");
    set(GROUND_, 66, "B");
    setRect(GROUND_ - 2, 30, GROUND_ - 2, 31, "F");
    setRect(GROUND_ - 2, 50, GROUND_ - 2, 51, "F");
    set(GROUND_ - 3, 30, "C");
    set(GROUND_ - 1, 12, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 22 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 20 * TILE,
        x1: 30 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.4,
      },
      {
        x: 58 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 56 * TILE,
        x1: 68 * TILE - TILE * 2 + 8,
        dir: -1,
        speed: 1.32,
      },
    ];
    return { spawn: { x: 48, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel20(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 11; c <= 14; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 30; c2 <= 33; c2++) set(r, c2, " ");
    set(GROUND_, 22, "B");
    set(GROUND_ - 1, 26, "X");
    setRect(GROUND_ - 2, 38, GROUND_ - 2, 39, "F");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 18 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 16 * TILE,
        x1: 24 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.5,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel21(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 17; c++) set(r, c, " ");
    addVineColumn(set, setRect, GROUND_, 20, 21, 26);
    set(GROUND_ - 8, 23, "C");
    set(GROUND_ - 1, 32, "X");
    set(GROUND_, 28, "B");
    set(GROUND_ - 2, 36, GROUND_ - 2, 36, "F");
    set(GROUND_ - 1, 10, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 46, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel22(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    var pits = [9, 10, 22, 23, 38, 39, 52, 53];
    for (var r = GROUND_; r < ROWS; r++)
      for (var i = 0; i < pits.length; i += 2) {
        set(r, pits[i], " ");
        set(r, pits[i + 1], " ");
      }
    set(GROUND_, 16, "B");
    set(GROUND_, 44, "B");
    set(GROUND_ - 1, 30, "X");
    set(GROUND_ - 1, 12, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 26 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 24 * TILE,
        x1: 34 * TILE - TILE * 2 + 8,
        dir: -1,
        speed: 1.55,
      },
    ];
    return { spawn: { x: 48, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel23(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 12; c <= 15; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 28; c2 <= 31; c2++) set(r, c2, " ");
    set(GROUND_, 18, "B");
    set(GROUND_, 34, "B");
    set(GROUND_ - 1, 20, "X");
    set(GROUND_ - 1, 40, "X");
    setRect(GROUND_ - 2, 24, GROUND_ - 2, 25, "F");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 44, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel24(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 18; c <= 21; c++) set(r, c, " ");
    setRect(GROUND_ - 1, 26, GROUND_ - 1, 32, "S");
    setRect(GROUND_ - 2, 28, GROUND_ - 2, 32, "S");
    set(GROUND_, 36, "B");
    set(GROUND_ - 2, 34, GROUND_ - 2, 34, "F");
    set(GROUND_ - 1, 10, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel25(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 10; c <= 12; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 24; c2 <= 26; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 42; c3 <= 44; c3++) set(r, c3, " ");
    set(GROUND_ - 1, 18, "X");
    set(GROUND_ - 1, 36, "X");
    set(GROUND_, 20, "B");
    set(GROUND_, 50, "B");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 52, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel26(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 18; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 34; c2 <= 38; c2++) set(r, c2, " ");
    set(GROUND_ - 1, 28, "X");
    set(GROUND_ - 1, 52, "X");
    addVineColumn(set, setRect, GROUND_, 40, 41, 45);
    set(GROUND_ - 8, 43, "C");
    set(GROUND_ - 1, 10, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 24 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 22 * TILE,
        x1: 30 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.42,
      },
    ];
    return { spawn: { x: 48, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel27(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 17; c++) set(r, c, " ");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_ - 2, 28, GROUND_ - 2, 30, "F");
    set(GROUND_, 34, "B");
    set(GROUND_ - 1, 40, "X");
    set(GROUND_ - 1, 12, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 46, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel28(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 12; c <= 15; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 38; c2 <= 41; c2++) set(r, c2, " ");
    set(GROUND_, 26, "B");
    set(GROUND_, 52, "B");
    set(GROUND_ - 1, 30, "X");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, 58, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 20 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 18 * TILE,
        x1: 28 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.38,
      },
      {
        x: 48 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 46 * TILE,
        x1: 58 * TILE - TILE * 2 + 8,
        dir: -1,
        speed: 1.3,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel29(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 17; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 32; c2 <= 35; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 54; c3 <= 57; c3++) set(r, c3, " ");
    set(GROUND_ - 1, 24, "X");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_ - 1, 68, "X");
    set(GROUND_, 28, "B");
    set(GROUND_, 48, "B");
    set(GROUND_, 64, "B");
    setRect(GROUND_ - 2, 36, GROUND_ - 2, 37, "F");
    setRect(GROUND_ - 2, 58, GROUND_ - 2, 59, "F");
    set(GROUND_ - 3, 36, "C");
    set(GROUND_ - 1, 10, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 26 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 24 * TILE,
        x1: 34 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.46,
      },
      {
        x: 62 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 60 * TILE,
        x1: 72 * TILE - TILE * 2 + 8,
        dir: -1,
        speed: 1.34,
      },
    ];
    return { spawn: { x: 48, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  var LEVELS = [
    { name: "Sunrise Trail", cols: 90, build: buildLevel00 },
    { name: "Misty Marsh", cols: 44, build: buildLevel01 },
    { name: "Thorn Canopy", cols: 48, build: buildLevel02 },
    { name: "Broken Planks", cols: 40, build: buildLevel03 },
    { name: "Log Ferry", cols: 48, build: buildLevel04 },
    { name: "Twin Vines", cols: 52, build: buildLevel05 },
    { name: "Sky Crumble", cols: 46, build: buildLevel06 },
    { name: "Stone Steps", cols: 50, build: buildLevel07 },
    { name: "Triple Crossing", cols: 62, build: buildLevel08 },
    { name: "Temple Run", cols: 76, build: buildLevel09 },
    { name: "Bamboo Chute", cols: 50, build: buildLevel10 },
    { name: "Sunken Hollow", cols: 48, build: buildLevel11 },
    { name: "Root Maze", cols: 52, build: buildLevel12 },
    { name: "Creek Dash", cols: 46, build: buildLevel13 },
    { name: "Ridge Hoppers", cols: 54, build: buildLevel14 },
    { name: "Canopy Clash", cols: 48, build: buildLevel15 },
    { name: "Mudslide", cols: 56, build: buildLevel16 },
    { name: "Ghost Slope", cols: 50, build: buildLevel17 },
    { name: "Long Leap", cols: 64, build: buildLevel18 },
    { name: "Heart of Jungle", cols: 78, build: buildLevel19 },
    { name: "Tiger Gauntlet", cols: 52, build: buildLevel20 },
    { name: "Flooded Gully", cols: 50, build: buildLevel21 },
    { name: "Bait Line", cols: 58, build: buildLevel22 },
    { name: "Cinder Bridge", cols: 48, build: buildLevel23 },
    { name: "Echo Caves", cols: 54, build: buildLevel24 },
    { name: "Windmire Pass", cols: 56, build: buildLevel25 },
    { name: "Shattered Walk", cols: 64, build: buildLevel26 },
    { name: "Twin Scarps", cols: 50, build: buildLevel27 },
    { name: "Last Clearing", cols: 72, build: buildLevel28 },
    { name: "Skybreaker", cols: 84, build: buildLevel29 },
  ];

  function loadLevel(idx) {
    var def = LEVELS[idx];
    if (!def) return;
    currentLevel = idx;
    COLS = def.cols;
    grid = Array.from({ length: ROWS }, function () {
      return Array(COLS).fill(" ");
    });
    var set = function (r, c, v) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) grid[r][c] = v;
    };
    var setRect = function (r1, c1, r2, c2, v) {
      for (var r = r1; r <= r2; r++) for (var c = c1; c <= c2; c++) set(r, c, v);
    };
    var out = def.build(grid, COLS, GROUND, set, setRect);
    levelSpawn = out.spawn;
    movers = out.movers || [];
    for (var k in crumble) delete crumble[k];
    for (var r = 0; r < ROWS; r++)
      for (var c = 0; c < COLS; c++) {
        if (grid[r][c] === "F") crumble[r + "," + c] = { state: "solid", t: 0 };
      }
    totalGems = 0;
    for (var gr = 0; gr < ROWS; gr++)
      for (var gc = 0; gc < COLS; gc++) if (grid[gr][gc] === "C") totalGems++;
    LEVEL_W = COLS * TILE;
    gemsCollected.clear();
    syncHudLevel();
    syncCanvasViewportSize();
    if (global.JungleBg && typeof global.JungleBg.resetAmbient === "function") {
      global.JungleBg.resetAmbient();
    }
    bombs = [];
    volatileRestores = [];
    devilTimer =
      currentLevel >= DEVIL_DIFFICULTY_FROM_INDEX ? 1.4 + Math.random() * 2.2 : 0;
  }

  function syncHudLevel() {
    if (!opts) return;
    var def = LEVELS[currentLevel];
    if (opts.levelBadge)
      opts.levelBadge.textContent =
        "🌿 " + (currentLevel + 1) + "/" + LEVELS.length + " — " + (def ? def.name : "");
    if (opts.gemsMaxLabel) opts.gemsMaxLabel.textContent = "/" + totalGems;
    if (opts.gems) opts.gems.textContent = "0";
  }

  function resetPlayer() {
    player.x = levelSpawn.x;
    player.y = levelSpawn.y;
    player.vx = 0;
    player.vy = 0;
    player.alive = true;
    player.deathT = 0;
    player.facing = 1;
    player.state = "idle";
    player.vineAttachCol = -1;
    player.vineSwing = 0;
    player.vineSwingVel = 0;
    cameraX = 0;
    for (var k in crumble) crumble[k] = { state: "solid", t: 0 };
    bombs = [];
  }

  function syncRunButtonVisual() {
    if (!runTouchButton) return;
    var on = !!touchRunFast;
    runTouchButton.classList.toggle("is-fast", on);
    runTouchButton.setAttribute("aria-checked", on ? "true" : "false");
  }

  function rollDevilEvent() {
    if (currentLevel < DEVIL_DIFFICULTY_FROM_INDEX || !player.alive || gameState !== "playing") return;
    var r = Math.random();
    /* Fewer surprise floor holes than bombs; bombs slowed in spawnBombFromSky / updateBombs. */
    if (r < 0.28) voidGroundAhead();
    else if (r < 0.72) spawnBombFromSky();
    else crumbleRandomFNearPlayer();
  }

  function voidGroundAhead() {
    var pc = Math.floor((player.x + player.w / 2) / TILE);
    var aheadMag = 4 + Math.floor(Math.random() * 4);
    var ahead = player.facing * aheadMag;
    var col = pc + ahead;
    if (col < 2 || col >= COLS - 2) return;
    var standC0 = Math.floor(player.x / TILE);
    var standC1 = Math.floor((player.x + player.w - 1) / TILE);
    var standR0 = Math.floor(player.y / TILE);
    var standR1 = Math.floor((player.y + player.h - 1) / TILE);
    var cushion = 2;
    var safeLo = standC0 - cushion;
    var safeHi = standC1 + cushion;
    if (col >= safeLo && col <= safeHi) return;
    var rowsTry = [GROUND, GROUND - 1];
    for (var ti = 0; ti < rowsTry.length; ti++) {
      var rr = rowsTry[ti];
      if (rr < 0 || rr >= ROWS) continue;
      if (col >= standC0 && col <= standC1 && rr >= standR0 && rr <= standR1) continue;
      var t = grid[rr][col];
      if (t === "G" || t === "B") {
        volatileRestores.push({ r: rr, c: col, tile: t, t: 2.8 + Math.random() * 2.2 });
        grid[rr][col] = " ";
        spawnSparkle(col * TILE + TILE / 2, rr * TILE + TILE / 2);
        return;
      }
    }
  }

  function crumbleRandomFNearPlayer() {
    var pc = Math.floor((player.x + player.w / 2) / TILE);
    var candidates = [];
    var c0 = Math.max(1, pc - 6);
    var c1 = Math.min(COLS - 2, pc + 8);
    for (var rr = GROUND - 4; rr <= GROUND + 1; rr++) {
      if (rr < 0 || rr >= ROWS) continue;
      for (var cc = c0; cc <= c1; cc++) {
        if (grid[rr][cc] !== "F") continue;
        var key = rr + "," + cc;
        if (crumble[key] && crumble[key].state === "solid") candidates.push(key);
      }
    }
    if (!candidates.length) return;
    var pick = candidates[Math.floor(Math.random() * candidates.length)];
    var parts = pick.split(",");
    var fr = +parts[0];
    var fc = +parts[1];
    if (crumble[pick]) crumble[pick].state = "shaking";
    spawnSparkle(fc * TILE + TILE / 2, fr * TILE + TILE / 2);
  }

  function spawnBombFromSky() {
    var spread = 140 + Math.min(220, currentLevel * 8);
    var bx = player.x - spread * 0.35 + Math.random() * spread;
    bx = Math.max(cameraX + 24, Math.min(cameraX + W - 36, bx));
    bombs.push({
      x: bx,
      y: -56,
      vy: 1.15 + Math.random() * 0.75,
      phase: "fall",
      flash: 0,
    });
  }

  function updateBombs(dt) {
    var groundY = GROUND * TILE - 18;
    for (var i = bombs.length - 1; i >= 0; i--) {
      var b = bombs[i];
      if (b.phase === "fall") {
        b.vy += 0.24;
        b.y += b.vy;
        var dx = (player.x + player.w / 2 - b.x) * 0.009;
        b.x += dx;
        if (b.y >= groundY) {
          b.y = groundY;
          b.phase = "flash";
          b.flash = 0.68;
        }
        if (rectOverlap(player.x + 2, player.y + 2, player.w - 4, player.h - 4, b.x - 10, b.y - 10, 28, 28)) die();
      } else if (b.phase === "flash") {
        b.flash -= dt;
        if (rectOverlap(player.x, player.y, player.w, player.h, b.x - 52, b.y - 52, 104, 104)) die();
        if (b.flash <= 0) {
          for (var k = 0; k < 18; k++) {
            particles.push({
              x: b.x,
              y: b.y,
              vx: (Math.random() - 0.5) * 10,
              vy: (Math.random() - 0.5) * 10,
              life: 35 + Math.random() * 25,
              color: ["#ff6b35", "#fce17a", "#c0392b"][k % 3],
              size: 3 + Math.random() * 4,
            });
          }
          bombs.splice(i, 1);
        }
      }
    }
  }

  function updateVolatileRestores(dt) {
    for (var j = volatileRestores.length - 1; j >= 0; j--) {
      var v = volatileRestores[j];
      v.t -= dt;
      if (v.t <= 0) {
        if (grid[v.r][v.c] === " ") grid[v.r][v.c] = v.tile;
        volatileRestores.splice(j, 1);
      }
    }
  }

  function drawBombsWorld() {
    for (var i = 0; i < bombs.length; i++) {
      var b = bombs[i];
      ctx.save();
      if (b.phase === "flash") {
        var pulse = 0.5 + 0.5 * Math.sin(b.flash * 40);
        ctx.globalAlpha = 0.35 + pulse * 0.45;
        ctx.fillStyle = "rgba(255, 200, 80, " + (0.25 + pulse * 0.35) + ")";
        ctx.beginPath();
        ctx.arc(b.x, b.y, 72, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#2a1810";
      ctx.beginPath();
      ctx.arc(b.x, b.y + 3, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = b.phase === "flash" ? "#ff4422" : "#c0392b";
      ctx.beginPath();
      ctx.arc(b.x, b.y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fce17a";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#ffee99";
      ctx.fillRect(b.x - 2, b.y - 14, 4, 7);
      ctx.restore();
    }
  }

  function jumpPressed() {
    return !!(
      keys["Space"] ||
      keys["ArrowUp"] ||
      keys["KeyW"] ||
      (touchInput.jump && !touchJumpSuppress)
    );
  }
  function jumpHeld() {
    return !!(keys["Space"] || keys["ArrowUp"] || keys["KeyW"] || (touchInput.jump && !touchJumpSuppress));
  }

  function tileSolid(t, r, c) {
    if (t === "G" || t === "B" || t === "D" || t === "S") return true;
    if (t === "F") {
      var key = r + "," + c;
      return crumble[key] && crumble[key].state !== "gone";
    }
    return false;
  }

  function rectOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function getTileBounds(p) {
    return {
      c1: Math.max(0, Math.floor(p.x / TILE)),
      c2: Math.min(COLS - 1, Math.floor((p.x + p.w - 1) / TILE)),
      r1: Math.max(0, Math.floor(p.y / TILE)),
      r2: Math.min(ROWS - 1, Math.floor((p.y + p.h - 1) / TILE)),
    };
  }

  function moveAndCollide(p, dx, dy) {
    p.x += dx;
    var bounds = getTileBounds(p);
    for (var r = bounds.r1; r <= bounds.r2; r++) {
      for (var c = bounds.c1; c <= bounds.c2; c++) {
        var t = grid[r][c];
        if (tileSolid(t, r, c)) {
          var tx = c * TILE;
          if (dx > 0) p.x = tx - p.w;
          else if (dx < 0) p.x = tx + TILE;
          p.vx = 0;
        }
      }
    }
    p.y += dy;
    bounds = getTileBounds(p);
    p.onGround = false;
    for (r = bounds.r1; r <= bounds.r2; r++) {
      for (c = bounds.c1; c <= bounds.c2; c++) {
        t = grid[r][c];
        if (tileSolid(t, r, c)) {
          var ty = r * TILE;
          if (dy > 0) {
            p.y = ty - p.h;
            p.onGround = true;
            p.vy = 0;
            if (t === "F") {
              var k = r + "," + c;
              if (crumble[k].state === "solid") crumble[k].state = "shaking";
            }
          } else if (dy < 0) {
            p.y = ty + TILE;
            p.vy = 0;
          }
        }
      }
    }
    for (var i = 0; i < movers.length; i++) {
      var m = movers[i];
      if (rectOverlap(p.x, p.y, p.w, p.h, m.x, m.y, m.w, m.h)) {
        if (dy > 0 && p.y + p.h - dy <= m.y + 4) {
          p.y = m.y - p.h;
          p.onGround = true;
          p.vy = 0;
          p.x += m.dir * m.speed;
        }
      }
    }
  }

  function checkInteractions() {
    var cx = Math.floor((player.x + player.w / 2) / TILE);
    var r0 = Math.max(0, Math.floor(player.y / TILE) - 1);
    var r1 = Math.min(ROWS - 1, Math.floor((player.y + player.h) / TILE) + 1);
    var wasOnVine = player.onVine;
    var onVine = false;
    var vineAttachCol = -1;
    for (var r = r0; r <= r1; r++) {
      for (var c = Math.max(0, cx - 2); c <= Math.min(COLS - 1, cx + 2); c++) {
        var t = grid[r][c];
        var tx = c * TILE;
        var ty = r * TILE;
        if (t === "V") {
          var midX = player.x + player.w / 2;
          var vineCX = tx + TILE / 2;
          var horizOK = Math.abs(midX - vineCX) < TILE * 0.62;
          if (horizOK && rectOverlap(player.x, player.y, player.w, player.h, tx + 2, ty, TILE - 4, TILE)) {
            onVine = true;
            vineAttachCol = c;
          }
        }
        if (
          (t === "X" || t === "B") &&
          rectOverlap(player.x + 4, player.y + 6, player.w - 8, player.h - 8, tx + 4, ty + 8, TILE - 8, TILE - 12)
        )
          die();
        if (t === "C" && !gemsCollected.has(r + "," + c)) {
          if (rectOverlap(player.x, player.y, player.w, player.h, tx + 6, ty + 6, TILE - 12, TILE - 12)) {
            gemsCollected.add(r + "," + c);
            spawnSparkle(tx + TILE / 2, ty + TILE / 2);
          }
        }
        if (t === "E" && rectOverlap(player.x, player.y, player.w, player.h, tx, ty, TILE, TILE)) win();
      }
    }
    player.onVine = onVine;
    if (onVine && vineAttachCol >= 0) {
      if (!wasOnVine) {
        var vcx = vineAttachCol * TILE + TILE / 2;
        player.vineSwing = player.x + player.w / 2 - vcx;
        player.vineSwingVel = player.vx * 0.4;
        player.vineSwing = Math.max(-26, Math.min(26, player.vineSwing));
      }
      player.vineAttachCol = vineAttachCol;
    }
    if (!onVine && wasOnVine) {
      player.vineAttachCol = -1;
      player.vineSwing = 0;
      player.vineSwingVel = 0;
    }
    if (player.y > LEVEL_H + 100) die();
  }

  function die() {
    if (!player.alive) return;
    player.alive = false;
    player.deathT = 0;
    for (var i = 0; i < 24; i++) {
      particles.push({
        x: player.x + player.w / 2,
        y: player.y + player.h / 2,
        vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.8) * 6,
        life: 60,
        color: ["#e84a4a", "#ffb347", "#fce17a"][i % 3],
        size: 3 + Math.random() * 3,
      });
    }
  }

  function win() {
    if (gameState !== "playing") return;
    var isFinal = currentLevel >= LEVELS.length - 1;
    gameState = isFinal ? "won" : "levelComplete";
    if (opts && opts.onWin) {
      opts.onWin({
        levelIndex: currentLevel,
        isFinal: isFinal,
        time: levelTime,
        gems: gemsCollected.size,
        gemsMax: totalGems,
        lives: lives,
      });
    }
  }

  function loseNotify() {
    if (opts && opts.onLose) {
      opts.onLose({
        levelIndex: currentLevel,
        gems: gemsCollected.size,
        gemsMax: totalGems,
      });
    }
  }

  function spawnSparkle(x, y) {
    for (var i = 0; i < 12; i++) {
      particles.push({
        x: x,
        y: y,
        vx: (Math.random() - 0.5) * 4,
        vy: (Math.random() - 1) * 3,
        life: 40,
        color: "#7fffe0",
        size: 2 + Math.random() * 2,
      });
    }
  }

  function update(dt) {
    if (paused || !mounted) return;
    if (gameState !== "playing") return;
    levelTime += dt;
    if (player.alive) {
      var running = keys["ShiftLeft"] || keys["ShiftRight"] || touchRunFast;
      var speed = running ? RUN : WALK;
      var ax = 0;
      if (keys["ArrowLeft"] || keys["KeyA"] || touchInput.left) {
        ax = -1;
        player.facing = -1;
      }
      if (keys["ArrowRight"] || keys["KeyD"] || touchInput.right) {
        ax = 1;
        player.facing = 1;
      }
      if (player.onVine) {
        var vineCol = player.vineAttachCol >= 0 ? player.vineAttachCol : 40;
        var vineCenterX = vineCol * TILE + TILE / 2;
        player.vy = 0;
        if (keys["ArrowUp"] || keys["KeyW"] || touchInput.up) player.vy = -CLIMB_SPEED;
        if (keys["ArrowDown"] || keys["KeyS"] || touchInput.down) player.vy = CLIMB_SPEED;
        player.vineSwingVel += ax * (0.58 * phy);
        player.vineSwingVel *= 0.86;
        player.vineSwing += player.vineSwingVel;
        var maxSwing = 26;
        player.vineSwing = Math.max(-maxSwing, Math.min(maxSwing, player.vineSwing));
        if (!ax) player.vineSwingVel *= 0.91;
        player.x = vineCenterX - player.w / 2 + player.vineSwing;
        player.vx = player.vineSwingVel;
        player.state = "climb";
        if (jumpPressed()) {
          player.vy = -JUMP * 0.92;
          player.vx = player.vineSwingVel * 4.2 + ax * speed * 0.7;
          player.onVine = false;
          player.vineAttachCol = -1;
          player.vineSwing = 0;
          player.vineSwingVel = 0;
          keys["Space"] = false;
          if (touchInput.jump) touchJumpSuppress = true;
          moveAndCollide(player, player.vx, 0);
          moveAndCollide(player, 0, player.vy);
        } else moveAndCollide(player, 0, player.vy);
      } else {
        var target = ax * speed;
        var accel = player.onGround ? (useComfortPhysics ? 0.28 : 0.35) : useComfortPhysics ? 0.17 : 0.22;
        player.vx += (target - player.vx) * accel;
        if (player.onGround) player.coyote = 8;
        else player.coyote = Math.max(0, player.coyote - 1);
        if (jumpPressed()) player.jumpBuf = 8;
        else player.jumpBuf = Math.max(0, player.jumpBuf - 1);
        if (player.jumpBuf > 0 && player.coyote > 0) {
          player.vy = -JUMP;
          player.onGround = false;
          player.coyote = 0;
          player.jumpBuf = 0;
        }
        if (player.vy < -4 && !jumpHeld()) player.vy += 0.4;
        player.vy += GRAVITY;
        if (player.vy > MAX_FALL) player.vy = MAX_FALL;
        if (!player.onGround) player.state = player.vy < 0 ? "jump" : "fall";
        else if (Math.abs(player.vx) > 0.1) player.state = running ? "run" : "walk";
        else player.state = "idle";
        moveAndCollide(player, player.vx, 0);
        moveAndCollide(player, 0, player.vy);
      }
      player.runT += Math.abs(player.vx) * 0.02 + 0.02;
      checkInteractions();
    } else {
      player.deathT += dt;
      player.vy += GRAVITY * 0.6;
      player.y += player.vy;
      if (player.deathT > 1.0) {
        lives--;
        if (opts && opts.lives) opts.lives.textContent = String(lives);
        if (lives <= 0) {
          gameState = "lost";
          loseNotify();
        } else resetPlayer();
      }
    }
    for (var k in crumble) {
      var c = crumble[k];
      if (c.state === "shaking") {
        c.t += dt;
        if (c.t > 0.4) {
          c.state = "gone";
          c.t = 0;
        }
      } else if (c.state === "gone") {
        c.t += dt;
        if (c.t > 3.0) {
          c.state = "solid";
          c.t = 0;
        }
      }
    }
    for (var m = 0; m < movers.length; m++) {
      var mv = movers[m];
      mv.x += mv.dir * mv.speed;
      if (mv.x < mv.x0) {
        mv.x = mv.x0;
        mv.dir = 1;
      }
      if (mv.x > mv.x1) {
        mv.x = mv.x1;
        mv.dir = -1;
      }
    }
    if (currentLevel >= DEVIL_DIFFICULTY_FROM_INDEX) {
      devilTimer -= dt;
      if (devilTimer <= 0 && player.alive && gameState === "playing") {
        var pace = 5.4 + Math.random() * 3.2 - currentLevel * 0.05;
        devilTimer = Math.max(1.9, pace);
        rollDevilEvent();
      }
      updateVolatileRestores(dt);
      updateBombs(dt);
    }
    for (var pi = 0; pi < particles.length; pi++) {
      var p = particles[pi];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.2;
      p.life--;
    }
    particles = particles.filter(function (p) {
      return p.life > 0;
    });
    var targetCam = player.x - W * 0.4;
    cameraX += (targetCam - cameraX) * 0.15;
    cameraX = Math.max(0, Math.min(LEVEL_W - W, cameraX));
    if (opts) {
      if (opts.time) opts.time.textContent = levelTime.toFixed(1);
      if (opts.gems) opts.gems.textContent = String(gemsCollected.size);
    }
  }

  function drawGrass(x, y) {
    ctx.fillStyle = "#5a3d1f";
    ctx.fillRect(x, y + 10, TILE, TILE - 10);
    ctx.fillStyle = "#2d7a38";
    ctx.fillRect(x, y, TILE, 12);
    ctx.fillStyle = "#4ab856";
    for (var i = 0; i < 5; i++) ctx.fillRect(x + i * 8 + 2, y - 2, 3, 6);
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(x, y + TILE - 2, TILE, 2);
  }
  function drawDirt(x, y) {
    ctx.fillStyle = "#5c4228";
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = "#4a351c";
    ctx.fillRect(x + 4, y + 8, 6, 6);
    ctx.fillRect(x + 22, y + 18, 5, 5);
    ctx.fillRect(x + 30, y + 5, 4, 4);
  }
  function drawStone(x, y) {
    ctx.fillStyle = "#7d7d7d";
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = "#5d5d5d";
    ctx.fillRect(x + 4, y + 6, 8, 4);
    ctx.fillRect(x + 24, y + 22, 8, 4);
  }
  function drawSpike(x, y) {
    ctx.fillStyle = "#6e4a2a";
    ctx.fillRect(x, y + TILE - 6, TILE, 6);
    ctx.fillStyle = "#c0c4cc";
    for (var i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * 8, y + TILE - 6);
      ctx.lineTo(x + i * 8 + 4, y + 10);
      ctx.lineTo(x + i * 8 + 8, y + TILE - 6);
      ctx.closePath();
      ctx.fill();
    }
  }
  function drawCrumble(x, y, cr) {
    if (!cr || cr.state === "gone") return;
    var off = 0;
    var alpha = 1;
    if (cr.state === "shaking") {
      off = (Math.random() - 0.5) * 4;
      alpha = 1 - cr.t / 0.5;
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0.3, alpha);
    ctx.translate(off, off);
    ctx.fillStyle = "#9c5c2e";
    ctx.fillRect(x, y, TILE, 18);
    ctx.fillStyle = "#7a4521";
    ctx.fillRect(x, y + 12, TILE, 6);
    ctx.strokeStyle = "#3a1f10";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 8, y + 2);
    ctx.lineTo(x + 14, y + 10);
    ctx.lineTo(x + 10, y + 16);
    ctx.moveTo(x + 24, y + 4);
    ctx.lineTo(x + 30, y + 12);
    ctx.stroke();
    ctx.restore();
  }
  function drawVine(x, y) {
    var bend =
      player.onVine && Math.abs(player.vineSwing) > 0.5
        ? player.vineSwing * 0.08 * (1 - (y - player.y) / 120)
        : 0;
    ctx.save();
    ctx.translate(bend, 0);
    ctx.fillStyle = "#2d5a2d";
    ctx.fillRect(x + TILE / 2 - 2, y, 4, TILE);
    ctx.fillStyle = "#56b04a";
    for (var i = 0; i < 3; i++) {
      var ly = y + i * 14 + 4;
      ctx.beginPath();
      ctx.ellipse(x + TILE / 2 - 8, ly, 6, 3, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x + TILE / 2 + 8, ly + 6, 6, 3, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  function drawGem(x, y) {
    var cx = x + TILE / 2;
    var cy = y + TILE / 2 + Math.sin(performance.now() / 300 + x) * 3;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    var g = ctx.createLinearGradient(-10, -10, 10, 10);
    g.addColorStop(0, "#7fffe0");
    g.addColorStop(1, "#1a8c80");
    ctx.fillStyle = g;
    ctx.fillRect(-10, -10, 20, 20);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(-7, -7, 4, 4);
    ctx.restore();
  }
  function drawEndFlag(x, y) {
    ctx.fillStyle = "#d4af37";
    ctx.fillRect(x + TILE / 2 - 2, y - TILE, 4, TILE * 2);
    var wave = Math.sin(performance.now() / 200) * 4;
    ctx.fillStyle = "#e84a4a";
    ctx.beginPath();
    ctx.moveTo(x + TILE / 2 + 2, y - TILE + 4);
    ctx.lineTo(x + TILE / 2 + 30 + wave, y - TILE + 12);
    ctx.lineTo(x + TILE / 2 + 2, y - TILE + 22);
    ctx.closePath();
    ctx.fill();
  }

  function drawTiles() {
    var c1 = Math.max(0, Math.floor(cameraX / TILE) - 1);
    var c2 = Math.min(COLS - 1, Math.floor((cameraX + W) / TILE) + 1);
    for (var r = 0; r < ROWS; r++) {
      for (var c = c1; c <= c2; c++) {
        var t = grid[r][c];
        if (t === " ") continue;
        var x = c * TILE;
        var y = r * TILE;
        switch (t) {
          case "G":
            drawGrass(x, y);
            break;
          case "B":
            drawGrass(x, y);
            break;
          case "D":
            drawDirt(x, y);
            break;
          case "S":
            drawStone(x, y);
            break;
          case "X":
            drawSpike(x, y);
            break;
          case "F":
            drawCrumble(x, y, crumble[r + "," + c]);
            break;
          case "V":
            drawVine(x, y);
            break;
          case "C":
            if (!gemsCollected.has(r + "," + c)) drawGem(x, y);
            break;
          case "E":
            drawEndFlag(x, y);
            break;
        }
      }
    }
  }

  function drawMovers() {
    for (var i = 0; i < movers.length; i++) {
      var m = movers[i];
      ctx.fillStyle = "#5a3b22";
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.fillStyle = "#8b6038";
      ctx.fillRect(m.x, m.y, m.w, 4);
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m.x + 8, 0);
      ctx.lineTo(m.x + 8, m.y);
      ctx.moveTo(m.x + m.w - 8, 0);
      ctx.lineTo(m.x + m.w - 8, m.y);
      ctx.stroke();
    }
  }

  /** Explorer sprite: rounded shapes, hat, scarf, backpack, boots */
  function drawPlayer() {
    var p = player;
    var cx = p.x + p.w / 2;
    var cy = p.y + p.h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(p.facing, 1);
    ctx.translate(-p.w / 2, -p.h / 2);
    if (!p.alive) ctx.globalAlpha = Math.max(0, 1 - p.deathT);
    if (p.state === "climb" && Math.abs(p.vineSwing) > 0.25) {
      ctx.translate(p.facing * p.vineSwing * 0.24, 0);
      ctx.rotate(p.facing * p.vineSwing * 0.006);
    }
    var t = p.runT;
    var bob = p.state === "walk" || p.state === "run" ? Math.sin(t * 8) * 2 : 0;
    var armSwing = Math.sin(t * 8) * (p.state === "run" ? 12 : 8);
    var legSwing = Math.sin(t * 8) * (p.state === "run" ? 14 : 10);

    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.ellipse(p.w / 2, p.h + 2, 14, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#4a3728";
    ctx.fillRect(-3, 16 + bob, 8, 14);
    ctx.fillStyle = "#c07a3a";
    ctx.fillRect(-2, 18 + bob, 6, 10);

    ctx.fillStyle = "#3a4a6b";
    if (p.state === "jump" || p.state === "fall") {
      ctx.fillRect(6, 24, 6, 12);
      ctx.fillRect(14, 22, 6, 14);
    } else if (p.state === "climb") {
      ctx.fillRect(6, 24 + Math.sin(t * 4) * 3, 6, 12);
      ctx.fillRect(14, 24 - Math.sin(t * 4) * 3, 6, 12);
    } else if (p.state === "walk" || p.state === "run") {
      ctx.fillRect(6, 24 + Math.max(0, legSwing * 0.3), 6, 12 - Math.max(0, legSwing * 0.3));
      ctx.fillRect(14, 24 - Math.min(0, legSwing * 0.3), 6, 12 + Math.min(0, legSwing * 0.3));
    } else {
      ctx.fillRect(6, 24, 6, 12);
      ctx.fillRect(14, 24, 6, 12);
    }
    ctx.fillStyle = "#1e1410";
    ctx.fillRect(5, 33, 8, 5);
    ctx.fillRect(13, 33, 8, 5);
    ctx.fillStyle = "#2a1810";
    ctx.fillRect(5, 36, 8, 3);
    ctx.fillRect(13, 36, 8, 3);

    var vest = ctx.createLinearGradient(4, 14, 22, 28);
    vest.addColorStop(0, "#8b6239");
    vest.addColorStop(1, "#5c3d24");
    ctx.fillStyle = vest;
    ctx.fillRect(3, 14 + bob, 20, 13);
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 1;
    ctx.strokeRect(3, 14 + bob, 20, 13);
    ctx.fillStyle = "#d6b480";
    ctx.fillRect(6, 17 + bob, 14, 4);
    ctx.fillStyle = "#c0392b";
    ctx.fillRect(3, 24 + bob, 20, 2);

    ctx.fillStyle = "#e8b87a";
    if (p.state === "climb") {
      ctx.fillRect(0, 10 + Math.sin(t * 4) * 3, 5, 12);
      ctx.fillRect(21, 10 - Math.sin(t * 4) * 3, 5, 12);
    } else if (p.state === "jump" || p.state === "fall") {
      ctx.fillRect(0, 12, 5, 10);
      ctx.fillRect(21, 12, 5, 10);
    } else if (p.state === "walk" || p.state === "run") {
      ctx.fillRect(0, 14 + bob + Math.max(0, armSwing * 0.3), 5, 10);
      ctx.fillRect(21, 14 + bob - Math.min(0, armSwing * 0.3), 5, 10);
    } else {
      ctx.fillRect(0, 14 + bob, 5, 10);
      ctx.fillRect(21, 14 + bob, 5, 10);
    }

    ctx.fillStyle = "#2e8b57";
    ctx.beginPath();
    ctx.moveTo(2, 18 + bob);
    ctx.lineTo(-2, 22 + bob);
    ctx.lineTo(2, 24 + bob);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#f0c79a";
    ctx.beginPath();
    ctx.ellipse(13, 7 + bob, 9, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c08a65";
    ctx.beginPath();
    ctx.arc(8, 9 + bob, 2, 0, Math.PI * 2);
    ctx.arc(18, 9 + bob, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#4a3220";
    ctx.beginPath();
    ctx.moveTo(5, 2 + bob);
    ctx.quadraticCurveTo(13, -4 + bob, 21, 2 + bob);
    ctx.lineTo(20, 5 + bob);
    ctx.lineTo(6, 5 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#6a4630";
    ctx.fillRect(6, 0 + bob, 14, 4);
    ctx.fillStyle = "#c0392b";
    ctx.fillRect(6, 3 + bob, 14, 2);

    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(15.5, 6 + bob, 2.2, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1a1a";
    ctx.beginPath();
    ctx.arc(16, 6.5 + bob, 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(15.2, 5.4 + bob, 1.2, 1);

    ctx.strokeStyle = "#8a5a44";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(14, 11 + bob, 2.5, 0.1, Math.PI - 0.1);
    ctx.stroke();

    ctx.restore();
  }

  function drawParticles() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.globalAlpha = Math.max(0, p.life / 60);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    var sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#4a8a72");
    sky.addColorStop(0.38, "#6ab87a");
    sky.addColorStop(0.72, "#3d8a4a");
    sky.addColorStop(1, "#2a5c38");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(220, 235, 140, 0.55)";
    ctx.beginPath();
    ctx.arc(W - 110, 88, 36, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(180, 210, 100, 0.18)";
    ctx.beginPath();
    ctx.arc(W - 110, 88, 62, 0, Math.PI * 2);
    ctx.fill();
    var nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    var lift =
      typeof viewportLiftPx === "number" && viewportLiftPx > 0
        ? viewportLiftPx
        : unityWebView || useComfortPhysics
          ? 56
          : 0;
    if (opts && typeof opts.viewportLiftPx === "number" && opts.viewportLiftPx > 0) lift = opts.viewportLiftPx;
    ctx.save();
    ctx.translate(0, -lift);
    if (global.JungleBg) {
      global.JungleBg.drawBackLayers(ctx, W, H, cameraX, nowMs);
    }
    ctx.translate(-cameraX, 0);
    drawTiles();
    drawMovers();
    drawPlayer();
    drawBombsWorld();
    drawParticles();
    ctx.restore();
    ctx.save();
    ctx.translate(0, -lift);
    if (global.JungleBg) {
      global.JungleBg.drawFallingLeavesAndAir(ctx, W, H, cameraX, nowMs, grid, COLS, ROWS, TILE);
      global.JungleBg.drawMistForeground(ctx, W, H, cameraX, nowMs);
    }
    ctx.restore();
    var vg = ctx.createRadialGradient(W / 2, H / 2, W * 0.3, W / 2, H / 2, W * 0.7);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(8, 42, 22, 0.42)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  function loop(now) {
    if (!mounted) return;
    rafId = requestAnimationFrame(loop);
    var dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    update(dt);
    render();
  }

  function onKeyDown(e) {
    keys[e.code] = true;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].indexOf(e.code) >= 0) e.preventDefault();
  }
  function onKeyUp(e) {
    keys[e.code] = false;
  }

  function bindTouch() {
    if (!opts || !opts.touchLayer) return;
    var layer = opts.touchLayer;
    function bindHold(el, prop) {
      function down() {
        touchInput[prop] = true;
        el.classList.add("active");
      }
      function up() {
        touchInput[prop] = false;
        el.classList.remove("active");
        if (prop === "jump") touchJumpSuppress = false;
      }
      function onPointerDown(e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        try {
          el.setPointerCapture(e.pointerId);
        } catch (_) {}
        down();
      }
      function onPointerUp(e) {
        try {
          if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        } catch (_) {}
        up();
      }
      trackAdd(el, "pointerdown", onPointerDown, false);
      trackAdd(el, "pointerup", onPointerUp, false);
      trackAdd(el, "pointercancel", up, false);
      trackAdd(el, "lostpointercapture", up, false);
    }
    layer.querySelectorAll("[data-touch]").forEach(function (el) {
      var t = el.getAttribute("data-touch");
      if (t === "run") return;
      if (t === "left") bindHold(el, "left");
      else if (t === "right") bindHold(el, "right");
      else if (t === "jump") bindHold(el, "jump");
      else if (t === "up") bindHold(el, "up");
      else if (t === "down") bindHold(el, "down");
    });
    var runEl = layer.querySelector('[data-touch="run"]');
    if (runEl) {
      runTouchButton = runEl;
      function onRunPointerDown(e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        touchRunFast = !touchRunFast;
        syncRunButtonVisual();
      }
      trackAdd(runEl, "pointerdown", onRunPointerDown, false);
      syncRunButtonVisual();
    }
  }

  function syncTouchToggle() {
    if (!opts || !opts.touchToggle) return;
    var on = document.body.classList.contains("touch-ui-force");
    opts.touchToggle.setAttribute("aria-pressed", on ? "true" : "false");
    opts.touchToggle.textContent = on ? "Hide controls" : "On-screen controls";
  }

  global.JungleGame = {
    LEVEL_COUNT: LEVELS.length,
    mount: function (options) {
      if (mounted) global.JungleGame.unmount();
      var c = options && options.canvas;
      var cx = c && typeof c.getContext === "function" ? c.getContext("2d") : null;
      if (!c || !cx) {
        opts = null;
        canvas = null;
        ctx = null;
        return;
      }
      opts = options;
      canvas = c;
      ctx = cx;
      viewportLiftPx =
        options && typeof options.viewportLiftPx === "number" ? Math.max(0, options.viewportLiftPx) : 0;
      detachFns = [];
      trackAdd(window, "keydown", onKeyDown, false);
      trackAdd(window, "keyup", onKeyUp, false);
      bindTouch();
      if (opts.mapBtn) {
        function onMapBtnClick() {
          paused = true;
          if (opts.onRequestMap) opts.onRequestMap();
        }
        trackAdd(opts.mapBtn, "click", onMapBtnClick, false);
      }
      if (opts.touchToggle) {
        function onTouchToggleClick() {
          document.body.classList.toggle("touch-ui-force");
          try {
            localStorage.setItem(
              "jungle-adventure-touch-ui",
              document.body.classList.contains("touch-ui-force") ? "1" : "0"
            );
          } catch (_) {}
          syncTouchToggle();
          if (opts.onTouchUiChanged) try {
            opts.onTouchUiChanged();
          } catch (_) {}
        }
        trackAdd(opts.touchToggle, "click", onTouchToggleClick, false);
        try {
          if (localStorage.getItem("jungle-adventure-touch-ui") === "1")
            document.body.classList.add("touch-ui-force");
        } catch (_) {}
        syncTouchToggle();
      }
      bindViewportResize();
      requestAnimationFrame(function () {
        syncCanvasViewportSize();
      });
      if (global.JungleBg && typeof global.JungleBg.load === "function") {
        global.JungleBg.load(function () {});
      }
      mounted = true;
      paused = false;
      gameState = "playing";
      lives = 3;
      levelTime = 0;
      particles = [];
      var startIdx = typeof opts.levelIndex === "number" ? opts.levelIndex : 0;
      loadLevel(startIdx);
      resetPlayer();
      if (opts.lives) opts.lives.textContent = String(lives);
      lastT = performance.now();
      rafId = requestAnimationFrame(loop);
    },
    unmount: function () {
      mounted = false;
      if (global.JungleBg && typeof global.JungleBg.resetAmbient === "function") {
        global.JungleBg.resetAmbient();
      }
      unbindViewportResize();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      for (var di = detachFns.length - 1; di >= 0; di--) {
        try {
          detachFns[di]();
        } catch (_) {}
      }
      detachFns = [];
      ctx = null;
      canvas = null;
      opts = null;
      runTouchButton = null;
      touchRunFast = false;
    },
    setViewportLiftPx: function (px) {
      viewportLiftPx = Math.max(0, Math.min(140, +px || 0));
    },
    setPaused: function (p) {
      paused = !!p;
      lastT = performance.now();
    },
    loadLevelIndex: function (i) {
      gameState = "playing";
      loadLevel(Math.max(0, Math.min(LEVELS.length - 1, i | 0)));
      resetPlayer();
      levelTime = 0;
      lives = 3;
      if (opts && opts.lives) opts.lives.textContent = String(lives);
      syncHudLevel();
    },
    resumeAfterOverlay: function (mode) {
      if (mode === "next") {
        if (currentLevel < LEVELS.length - 1) {
          currentLevel++;
          loadLevel(currentLevel);
          resetPlayer();
          levelTime = 0;
          gameState = "playing";
        }
      } else if (mode === "retry") {
        loadLevel(currentLevel);
        resetPlayer();
        levelTime = 0;
        lives = 3;
        if (opts && opts.lives) opts.lives.textContent = String(lives);
        gameState = "playing";
      } else if (mode === "restartCampaign") {
        loadLevel(0);
        resetPlayer();
        levelTime = 0;
        lives = 3;
        if (opts && opts.lives) opts.lives.textContent = String(lives);
        gameState = "playing";
      }
      syncHudLevel();
    },
    getGameState: function () {
      return gameState;
    },
    requestMap: function () {
      paused = true;
      if (opts && opts.onRequestMap) opts.onRequestMap();
    },
  };
})(typeof window !== "undefined" ? window : this);
