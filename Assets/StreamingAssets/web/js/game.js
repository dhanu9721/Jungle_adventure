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
  /** Devil-mode (random sky bombs and floor voids) only fires inside this index range. New worlds (4+) opt out. */
  var DEVIL_DIFFICULTY_TO_INDEX = 30;
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
    portalLockIdx: -1,
    gravityDir: 1,
    gravityFlipCooldown: 0,
    controlsReverseT: 0,
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

  /** Up to 2 P-tiles per level; entering one teleports to the other. */
  var portals = [];

  /** Rolling boulders: hazards that roll along the ground at constant velocity, respawn after leaving range. */
  var boulders = [];

  /** Homing missiles: track the player and accelerate toward them. Die on hitting a solid tile or off-screen. */
  var missiles = [];

  /** Reverser items: pop up randomly ahead of the player. Touching one inverts left/right input for ~4s. */
  var reversers = [];
  var reverserActive = false;
  var reverserSpawnT = 0;
  var reverserSpawnMin = 180;
  var reverserSpawnMax = 360;

  /** Frames remaining to show "collect all gems" banner when player touches end flag without all gems. */
  var gemHintT = 0;

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
    for (var r = GROUND_; r < ROWS; r++) for (var c = 21; c <= 23; c++) set(r, c, " ");
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
    set(GROUND_ - 1, 44, "C");
    set(GROUND_ - 1, ec - 1, "E");
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
    setRect(GROUND_ - 2, 34, GROUND_ - 2, 34, "F");
    setRect(GROUND_ - 6, 38, GROUND_ - 6, 42, "G");
    setRect(GROUND_ - 5, 38, GROUND_ - 5, 42, "D");
    set(GROUND_ - 3, 30, "P");
    set(GROUND_ - 7, 40, "P");
    set(GROUND_ - 7, 41, "C");
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
    for (var r = GROUND_; r < ROWS; r++) for (var c = 15; c <= 17; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 35; c2 <= 37; c2++) set(r, c2, " ");
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
    for (var r = GROUND_; r < ROWS; r++) for (var c = 15; c <= 17; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 33; c2 <= 35; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 55; c3 <= 57; c3++) set(r, c3, " ");
    set(GROUND_ - 1, 24, "X");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_ - 1, 68, "X");
    set(GROUND_, 28, "B");
    set(GROUND_, 48, "B");
    set(GROUND_, 64, "B");
    setRect(GROUND_ - 2, 38, GROUND_ - 2, 39, "F");
    setRect(GROUND_ - 2, 60, GROUND_ - 2, 61, "F");
    set(GROUND_ - 3, 38, "C");
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

  function buildLevel30(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 12; c <= 14; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 30; c2 <= 32; c2++) set(r, c2, " ");
    setRect(GROUND_ - 2, 20, GROUND_ - 2, 22, "F");
    set(GROUND_ - 3, 21, "C");
    setRect(GROUND_ - 2, 38, GROUND_ - 2, 40, "S");
    set(GROUND_ - 3, 39, "C");
    set(GROUND_ - 1, 18, "X");
    set(GROUND_, 26, "B");
    set(GROUND_ - 1, 35, "X");
    set(GROUND_, 44, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel31(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 12; c <= 26; c++) set(GROUND_ - 1, c, "X");
    set(GROUND_ - 2, 12, "S");
    set(GROUND_ - 2, 16, "S");
    set(GROUND_ - 2, 20, "S");
    set(GROUND_ - 2, 24, "S");
    set(GROUND_ - 3, 16, "C");
    set(GROUND_ - 3, 20, "C");
    set(GROUND_ - 3, 24, "C");
    for (var r = GROUND_; r < ROWS; r++) for (var c2 = 32; c2 <= 34; c2++) set(r, c2, " ");
    setRect(GROUND_ - 2, 33, GROUND_ - 2, 33, "F");
    set(GROUND_, 40, "B");
    set(GROUND_ - 1, 45, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel32(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 16; c <= 18; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 40; c2 <= 42; c2++) set(r, c2, " ");
    addVineColumn(set, setRect, GROUND_, 22, 23, 27);
    set(GROUND_ - 8, 24, "C");
    set(GROUND_ - 8, 26, "C");
    addVineColumn(set, setRect, GROUND_, 46, 47, 51);
    set(GROUND_ - 8, 48, "C");
    set(GROUND_ - 8, 50, "C");
    set(GROUND_ - 1, 32, "X");
    set(GROUND_, 36, "B");
    set(GROUND_ - 1, 54, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel33(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 24; c++) set(r, c, " ");
    setRect(GROUND_ - 2, 15, GROUND_ - 2, 15, "F");
    setRect(GROUND_ - 2, 18, GROUND_ - 2, 18, "F");
    setRect(GROUND_ - 2, 21, GROUND_ - 2, 21, "F");
    set(GROUND_ - 3, 18, "C");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 36; c2 <= 38; c2++) set(r, c2, " ");
    set(GROUND_, 32, "B");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_, 48, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 28, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 14 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 14 * TILE,
        x1: 24 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.6,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel34(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 12; c <= 14; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 28; c2 <= 36; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 52; c3 <= 58; c3++) set(r, c3, " ");
    setRect(GROUND_ - 2, 30, GROUND_ - 2, 30, "F");
    setRect(GROUND_ - 2, 34, GROUND_ - 2, 34, "F");
    set(GROUND_ - 3, 30, "C");
    addVineColumn(set, setRect, GROUND_, 44, 45, 49);
    set(GROUND_ - 8, 47, "C");
    set(GROUND_ - 1, 20, "X");
    set(GROUND_, 24, "B");
    set(GROUND_ - 1, 41, "X");
    set(GROUND_, 50, "B");
    set(GROUND_ - 1, 61, "X");
    setRect(GROUND_ - 2, 62, GROUND_ - 2, 64, "S");
    set(GROUND_ - 3, 63, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 18, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 28 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 28 * TILE,
        x1: 37 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.55,
      },
      {
        x: 52 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 52 * TILE,
        x1: 58 * TILE - TILE * 2 + 8,
        dir: -1,
        speed: 1.45,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel35(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 12; c <= 14; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 64; c2 <= 66; c2++) set(r, c2, " ");
    set(GROUND_ - 1, 22, "P");
    set(GROUND_ - 1, 56, "P");
    set(GROUND_, 28, "B");
    set(GROUND_ - 1, 34, "X");
    set(GROUND_, 40, "B");
    set(GROUND_ - 1, 46, "X");
    set(GROUND_ - 1, 25, "C");
    set(GROUND_ - 1, 31, "C");
    set(GROUND_ - 1, 37, "C");
    set(GROUND_ - 1, 43, "C");
    set(GROUND_ - 1, 49, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel36(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 18; c <= 48; c++) set(GROUND_ - 1, c, "X");
    addVineColumn(set, setRect, GROUND_, 14, 15, 17);
    set(GROUND_ - 8, 16, "P");
    set(GROUND_ - 8, 15, "C");
    set(GROUND_ - 1, 52, "P");
    for (var r = GROUND_; r < ROWS; r++) for (var c2 = 60; c2 <= 62; c2++) set(r, c2, " ");
    set(GROUND_ - 1, 56, "C");
    set(GROUND_ - 1, 68, "X");
    set(GROUND_, 74, "B");
    set(GROUND_ - 1, 80, "X");
    setRect(GROUND_ - 2, 70, GROUND_ - 2, 72, "S");
    set(GROUND_ - 3, 71, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 66, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel37(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 16; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 30; c2 <= 32; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 52; c3 <= 54; c3++) set(r, c3, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c4 = 74; c4 <= 76; c4++) set(r, c4, " ");
    setRect(GROUND_ - 2, 22, GROUND_ - 2, 22, "F");
    setRect(GROUND_ - 2, 42, GROUND_ - 2, 44, "S");
    set(GROUND_ - 3, 43, "C");
    addVineColumn(set, setRect, GROUND_, 60, 61, 65);
    set(GROUND_ - 8, 62, "C");
    set(GROUND_ - 8, 64, "C");
    set(GROUND_ - 1, 20, "X");
    set(GROUND_, 26, "B");
    set(GROUND_ - 1, 38, "X");
    set(GROUND_, 48, "B");
    set(GROUND_ - 1, 70, "X");
    set(GROUND_, 82, "B");
    set(GROUND_ - 1, 88, "X");
    setRect(GROUND_ - 2, 80, GROUND_ - 2, 82, "F");
    set(GROUND_ - 3, 81, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 36, "C");
    set(GROUND_ - 1, 58, "C");
    set(GROUND_ - 1, 92, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel38(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    set(GROUND_, 12, "B");
    set(GROUND_, 16, "B");
    set(GROUND_, 20, "B");
    set(GROUND_, 24, "B");
    set(GROUND_, 28, "B");
    set(GROUND_ - 1, 14, "X");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_ - 1, 26, "X");
    set(GROUND_ - 1, 32, "P");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 38; c <= 46; c++) set(r, c, " ");
    set(GROUND_ - 1, 64, "P");
    set(GROUND_, 54, "B");
    set(GROUND_ - 1, 58, "X");
    set(GROUND_, 70, "B");
    set(GROUND_ - 1, 74, "X");
    set(GROUND_, 78, "B");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 84; c2 <= 86; c2++) set(r, c2, " ");
    setRect(GROUND_ - 2, 40, GROUND_ - 2, 44, "S");
    set(GROUND_ - 3, 42, "C");
    set(GROUND_ - 1, 8, "C");
    set(GROUND_ - 1, 18, "C");
    set(GROUND_ - 1, 50, "C");
    set(GROUND_ - 1, 81, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 38 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 38 * TILE,
        x1: 47 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.5,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel39(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 16; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 32; c2 <= 40; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 60; c3 <= 62; c3++) set(r, c3, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c4 = 84; c4 <= 92; c4++) set(r, c4, " ");
    set(GROUND_ - 1, 28, "P");
    setRect(GROUND_ - 2, 34, GROUND_ - 2, 34, "F");
    setRect(GROUND_ - 2, 38, GROUND_ - 2, 38, "F");
    setRect(GROUND_ - 2, 88, GROUND_ - 2, 88, "F");
    addVineColumn(set, setRect, GROUND_, 50, 51, 55);
    set(GROUND_ - 8, 53, "C");
    set(GROUND_ - 8, 70, "P");
    setRect(GROUND_ - 7, 68, GROUND_ - 7, 72, "G");
    setRect(GROUND_ - 6, 68, GROUND_ - 6, 72, "D");
    set(GROUND_ - 8, 72, "C");
    setRect(GROUND_ - 2, 76, GROUND_ - 2, 78, "S");
    set(GROUND_ - 3, 77, "C");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_, 26, "B");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_, 48, "B");
    set(GROUND_ - 1, 66, "X");
    set(GROUND_, 82, "B");
    set(GROUND_ - 1, 96, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 24, "C");
    set(GROUND_ - 1, 46, "C");
    set(GROUND_ - 1, 100, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 32 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 32 * TILE,
        x1: 41 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.5,
      },
      {
        x: 84 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 84 * TILE,
        x1: 93 * TILE - TILE * 2 + 8,
        dir: -1,
        speed: 1.45,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel40(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 12; c <= 14; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 58; c2 <= 60; c2++) set(r, c2, " ");
    setRect(GROUND_ - 5, 30, GROUND_ - 5, 36, "G");
    setRect(GROUND_ - 4, 30, GROUND_ - 4, 36, "D");
    set(GROUND_ - 6, 33, "C");
    set(GROUND_ - 1, 18, "X");
    set(GROUND_, 24, "B");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_, 50, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 40, "C");
    set(GROUND_ - 1, 64, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        axis: "y",
        x: 28 * TILE,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        y0: (GROUND_ - 5) * TILE,
        y1: GROUND_ * TILE,
        dir: -1,
        speed: 1.3,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel41(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 16; c <= 36; c++) set(r, c, " ");
    setRect(GROUND_ - 5, 24, GROUND_ - 5, 28, "G");
    setRect(GROUND_ - 4, 24, GROUND_ - 4, 28, "D");
    set(GROUND_ - 6, 26, "C");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_, 50, "B");
    set(GROUND_ - 1, 56, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 40, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        axis: "y",
        x: 18 * TILE,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        y0: (GROUND_ - 5) * TILE,
        y1: GROUND_ * TILE,
        dir: -1,
        speed: 1.4,
      },
      {
        axis: "y",
        x: 32 * TILE,
        y: (GROUND_ - 5) * TILE,
        w: TILE * 2,
        h: 16,
        y0: (GROUND_ - 5) * TILE,
        y1: GROUND_ * TILE,
        dir: 1,
        speed: 1.5,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel42(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 16; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 30; c2 <= 38; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 70; c3 <= 72; c3++) set(r, c3, " ");
    setRect(GROUND_ - 4, 50, GROUND_ - 4, 56, "G");
    setRect(GROUND_ - 3, 50, GROUND_ - 3, 56, "D");
    set(GROUND_ - 5, 53, "C");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_, 26, "B");
    set(GROUND_ - 1, 42, "X");
    set(GROUND_, 62, "B");
    set(GROUND_ - 1, 78, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 46, "C");
    set(GROUND_ - 1, 66, "C");
    set(GROUND_ - 1, 84, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 30 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 30 * TILE,
        x1: 39 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.55,
      },
      {
        axis: "y",
        x: 60 * TILE,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        y0: (GROUND_ - 4) * TILE,
        y1: GROUND_ * TILE,
        dir: -1,
        speed: 1.4,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel43(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 16; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 36; c2 <= 38; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 80; c3 <= 82; c3++) set(r, c3, " ");
    set(GROUND_ - 1, 24, "P");
    setRect(GROUND_ - 6, 56, GROUND_ - 6, 62, "G");
    setRect(GROUND_ - 5, 56, GROUND_ - 5, 62, "D");
    set(GROUND_ - 7, 59, "P");
    set(GROUND_ - 7, 60, "C");
    set(GROUND_ - 7, 58, "C");
    set(GROUND_ - 1, 46, "X");
    set(GROUND_, 50, "B");
    set(GROUND_ - 1, 70, "X");
    set(GROUND_, 74, "B");
    set(GROUND_ - 1, 88, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 30, "C");
    set(GROUND_ - 1, 66, "C");
    set(GROUND_ - 1, 84, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        axis: "y",
        x: 52 * TILE,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        y0: (GROUND_ - 6) * TILE,
        y1: GROUND_ * TILE,
        dir: -1,
        speed: 1.45,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel44(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 16; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 32; c2 <= 40; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 60; c3 <= 62; c3++) set(r, c3, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c4 = 88; c4 <= 96; c4++) set(r, c4, " ");
    setRect(GROUND_ - 5, 50, GROUND_ - 5, 56, "G");
    setRect(GROUND_ - 4, 50, GROUND_ - 4, 56, "D");
    set(GROUND_ - 6, 53, "C");
    setRect(GROUND_ - 2, 76, GROUND_ - 2, 78, "F");
    set(GROUND_ - 3, 77, "C");
    addVineColumn(set, setRect, GROUND_, 100, 101, 105);
    set(GROUND_ - 8, 103, "C");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_, 26, "B");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_, 48, "B");
    set(GROUND_ - 1, 70, "X");
    set(GROUND_, 84, "B");
    set(GROUND_ - 1, 110, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 30, "C");
    set(GROUND_ - 1, 66, "C");
    set(GROUND_ - 1, 100, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 32 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 32 * TILE,
        x1: 41 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.55,
      },
      {
        axis: "y",
        x: 46 * TILE,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        y0: (GROUND_ - 5) * TILE,
        y1: GROUND_ * TILE,
        dir: -1,
        speed: 1.4,
      },
      {
        x: 88 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 88 * TILE,
        x1: 97 * TILE - TILE * 2 + 8,
        dir: -1,
        speed: 1.5,
      },
    ];
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: mv };
  }

  function buildLevel45(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 4, 54, GROUND_ - 4, 72, "G");
    setRect(GROUND_ - 3, 54, GROUND_ - 3, 72, "D");
    set(GROUND_ - 1, 50, "S");
    setRect(GROUND_ - 2, 51, GROUND_ - 1, 51, "S");
    setRect(GROUND_ - 3, 52, GROUND_ - 1, 52, "S");
    setRect(GROUND_ - 4, 53, GROUND_ - 1, 53, "S");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_, 30, "B");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 36, "C");
    set(GROUND_ - 1, 50, "C");
    set(GROUND_ - 5, 60, "C");
    set(GROUND_ - 1, 78, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 71 * TILE,
          y: (GROUND_ - 4) * TILE - 18,
          vx: -2.6,
          w: 36, h: 36,
          endX: 64 * TILE,
          cooldown: 320,
          initialDelay: 150,
        },
      ],
    };
  }

  function buildLevel46(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 28; c <= 30; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 60; c2 <= 62; c2++) set(r, c2, " ");
    setRect(GROUND_ - 4, 75, GROUND_ - 4, 88, "G");
    setRect(GROUND_ - 3, 75, GROUND_ - 3, 88, "D");
    set(GROUND_ - 1, 71, "S");
    setRect(GROUND_ - 2, 72, GROUND_ - 1, 72, "S");
    setRect(GROUND_ - 3, 73, GROUND_ - 1, 73, "S");
    setRect(GROUND_ - 4, 74, GROUND_ - 1, 74, "S");
    set(GROUND_ - 1, 14, "X");
    set(GROUND_, 22, "B");
    set(GROUND_ - 1, 42, "X");
    set(GROUND_, 50, "B");
    set(GROUND_ - 1, 70, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 18, "C");
    set(GROUND_ - 1, 34, "C");
    set(GROUND_ - 1, 56, "C");
    set(GROUND_ - 5, 82, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 86 * TILE,
          y: (GROUND_ - 4) * TILE - 18,
          vx: -3.4,
          w: 36, h: 36,
          endX: 78 * TILE,
          cooldown: 160,
          initialDelay: 0,
        },
        {
          spawnX: 26 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -2.8,
          w: 36, h: 36,
          endX: 4 * TILE,
          cooldown: 220,
          initialDelay: 90,
        },
      ],
    };
  }

  function buildLevel47(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 18; c <= 20; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 40; c2 <= 42; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 70; c3 <= 72; c3++) set(r, c3, " ");
    setRect(GROUND_ - 2, 28, GROUND_ - 2, 32, "S");
    set(GROUND_ - 3, 30, "C");
    setRect(GROUND_ - 2, 50, GROUND_ - 2, 52, "F");
    set(GROUND_ - 3, 51, "C");
    set(GROUND_ - 1, 26, "X");
    set(GROUND_, 36, "B");
    set(GROUND_ - 1, 60, "X");
    set(GROUND_, 66, "B");
    set(GROUND_ - 1, 80, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 46, "C");
    set(GROUND_ - 1, 76, "C");
    set(GROUND_ - 1, 86, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 90 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.6,
          w: 36, h: 36,
          endX: 4 * TILE,
          cooldown: 180,
          initialDelay: 30,
        },
      ],
    };
  }

  function buildLevel48(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 16; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 36; c2 <= 38; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 64; c3 <= 66; c3++) set(r, c3, " ");
    setRect(GROUND_ - 5, 46, GROUND_ - 5, 56, "G");
    setRect(GROUND_ - 4, 46, GROUND_ - 4, 56, "D");
    set(GROUND_ - 6, 51, "C");
    addVineColumn(set, setRect, GROUND_, 80, 81, 85);
    set(GROUND_ - 8, 83, "C");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_, 28, "B");
    set(GROUND_ - 1, 44, "X");
    set(GROUND_, 60, "B");
    set(GROUND_ - 1, 74, "X");
    set(GROUND_ - 1, 90, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 32, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [
        {
          axis: "y",
          x: 42 * TILE,
          y: GROUND_ * TILE,
          w: TILE * 2,
          h: 16,
          y0: (GROUND_ - 5) * TILE,
          y1: GROUND_ * TILE,
          dir: -1,
          speed: 1.45,
        },
      ],
      boulders: [
        {
          spawnX: 95 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.2,
          w: 36, h: 36,
          endX: 18 * TILE,
          cooldown: 180,
          initialDelay: 0,
        },
      ],
    };
  }

  function buildLevel49(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 14; c <= 16; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 38; c2 <= 46; c2++) set(r, c2, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c3 = 78; c3 <= 80; c3++) set(r, c3, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c4 = 110; c4 <= 118; c4++) set(r, c4, " ");
    setRect(GROUND_ - 6, 56, GROUND_ - 6, 66, "G");
    setRect(GROUND_ - 5, 56, GROUND_ - 5, 66, "D");
    set(GROUND_ - 7, 60, "P");
    set(GROUND_ - 1, 28, "P");
    setRect(GROUND_ - 2, 92, GROUND_ - 2, 96, "F");
    set(GROUND_ - 3, 94, "C");
    addVineColumn(set, setRect, GROUND_, 100, 101, 105);
    set(GROUND_ - 8, 103, "C");
    set(GROUND_ - 7, 61, "C");
    set(GROUND_ - 7, 63, "C");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_, 32, "B");
    set(GROUND_ - 1, 50, "X");
    set(GROUND_, 70, "B");
    set(GROUND_ - 1, 86, "X");
    set(GROUND_ - 1, 122, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 36, "C");
    set(GROUND_ - 1, 76, "C");
    set(GROUND_ - 1, 90, "C");
    set(GROUND_ - 1, 126, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [
        {
          x: 38 * TILE - 8,
          y: GROUND_ * TILE,
          w: TILE * 2,
          h: 16,
          x0: 38 * TILE,
          x1: 47 * TILE - TILE * 2 + 8,
          dir: 1,
          speed: 1.55,
        },
        {
          x: 110 * TILE - 8,
          y: GROUND_ * TILE,
          w: TILE * 2,
          h: 16,
          x0: 110 * TILE,
          x1: 119 * TILE - TILE * 2 + 8,
          dir: -1,
          speed: 1.5,
        },
      ],
      boulders: [
        {
          spawnX: 130 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.6,
          w: 36, h: 36,
          endX: 4 * TILE,
          cooldown: 180,
          initialDelay: 0,
        },
        {
          spawnX: 64 * TILE,
          y: (GROUND_ - 6) * TILE - 18,
          vx: -2.6,
          w: 32, h: 32,
          endX: 54 * TILE,
          cooldown: 220,
          initialDelay: 100,
        },
      ],
    };
  }

  function buildLevel50(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 28; c <= 58; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 24, GROUND_ - 7, 62, "G");
    setRect(GROUND_ - 8, 24, GROUND_ - 8, 62, "D");
    set(GROUND_ - 1, 26, "U");
    set(GROUND_ - 6, 60, "U");
    set(GROUND_ - 6, 36, "C");
    set(GROUND_ - 6, 44, "C");
    set(GROUND_ - 6, 52, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 18, "C");
    set(GROUND_ - 1, 68, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel51(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 22; c <= 70; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 18, GROUND_ - 7, 74, "G");
    setRect(GROUND_ - 8, 18, GROUND_ - 8, 74, "D");
    set(GROUND_ - 1, 20, "U");
    set(GROUND_ - 6, 72, "U");
    set(GROUND_ - 6, 28, "C");
    set(GROUND_ - 6, 38, "C");
    set(GROUND_ - 6, 48, "C");
    set(GROUND_ - 6, 58, "C");
    set(GROUND_ - 6, 66, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 12, "C");
    set(GROUND_ - 1, 80, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel52(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 16; c <= 38; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 14, GROUND_ - 7, 42, "G");
    setRect(GROUND_ - 8, 14, GROUND_ - 8, 42, "D");
    set(GROUND_ - 1, 14, "U");
    set(GROUND_ - 6, 40, "U");
    set(GROUND_ - 6, 22, "C");
    set(GROUND_ - 6, 32, "C");
    for (var c2 = 56; c2 <= 80; c2++) set(GROUND_ - 1, c2, "X");
    setRect(GROUND_ - 7, 54, GROUND_ - 7, 84, "G");
    setRect(GROUND_ - 8, 54, GROUND_ - 8, 84, "D");
    set(GROUND_ - 1, 54, "U");
    set(GROUND_ - 6, 82, "U");
    set(GROUND_ - 6, 64, "C");
    set(GROUND_ - 6, 74, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 48, "C");
    set(GROUND_ - 1, 90, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel53(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 22; c <= 78; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 18, GROUND_ - 7, 82, "G");
    setRect(GROUND_ - 8, 18, GROUND_ - 8, 82, "D");
    set(GROUND_ - 6, 36, "X");
    set(GROUND_ - 6, 48, "X");
    set(GROUND_ - 6, 64, "X");
    set(GROUND_ - 1, 20, "U");
    set(GROUND_ - 6, 80, "U");
    set(GROUND_ - 6, 28, "C");
    set(GROUND_ - 6, 42, "C");
    set(GROUND_ - 6, 56, "C");
    set(GROUND_ - 6, 72, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 14, "C");
    set(GROUND_ - 1, 88, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel54(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 18; c <= 36; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 16, GROUND_ - 7, 40, "G");
    setRect(GROUND_ - 8, 16, GROUND_ - 8, 40, "D");
    set(GROUND_ - 1, 16, "U");
    set(GROUND_ - 6, 38, "U");
    set(GROUND_ - 6, 24, "C");
    set(GROUND_ - 6, 32, "C");
    for (var r = GROUND_; r < ROWS; r++) for (var c2 = 50; c2 <= 52; c2++) set(r, c2, " ");
    set(GROUND_ - 1, 60, "P");
    set(GROUND_ - 1, 88, "P");
    set(GROUND_ - 1, 70, "X");
    set(GROUND_, 76, "B");
    setRect(GROUND_ - 5, 96, GROUND_ - 5, 102, "G");
    setRect(GROUND_ - 4, 96, GROUND_ - 4, 102, "D");
    set(GROUND_ - 1, 92, "S");
    setRect(GROUND_ - 2, 93, GROUND_ - 1, 93, "S");
    setRect(GROUND_ - 3, 94, GROUND_ - 1, 94, "S");
    setRect(GROUND_ - 4, 95, GROUND_ - 1, 95, "S");
    setRect(GROUND_ - 5, 96, GROUND_ - 5, 96, "S");
    set(GROUND_ - 6, 99, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 44, "C");
    set(GROUND_ - 1, 84, "C");
    set(GROUND_ - 1, 110, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        axis: "y",
        x: 56 * TILE,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        y0: (GROUND_ - 5) * TILE,
        y1: GROUND_ * TILE,
        dir: -1,
        speed: 1.4,
      },
    ];
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: mv,
      boulders: [
        {
          spawnX: 110 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 280,
          initialDelay: 200,
        },
      ],
    };
  }

  function buildLevel55(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c1 = 16; c1 <= 26; c1++) set(GROUND_ - 1, c1, "X");
    setRect(GROUND_ - 7, 14, GROUND_ - 7, 28, "G");
    setRect(GROUND_ - 8, 14, GROUND_ - 8, 28, "D");
    set(GROUND_ - 1, 14, "U");
    set(GROUND_ - 6, 28, "U");
    set(GROUND_ - 6, 21, "C");
    for (var c2 = 44; c2 <= 54; c2++) set(GROUND_ - 1, c2, "X");
    setRect(GROUND_ - 7, 42, GROUND_ - 7, 56, "G");
    setRect(GROUND_ - 8, 42, GROUND_ - 8, 56, "D");
    set(GROUND_ - 1, 42, "U");
    set(GROUND_ - 6, 56, "U");
    set(GROUND_ - 6, 49, "C");
    for (var c3 = 70; c3 <= 78; c3++) set(GROUND_ - 1, c3, "X");
    setRect(GROUND_ - 7, 68, GROUND_ - 7, 80, "G");
    setRect(GROUND_ - 8, 68, GROUND_ - 8, 80, "D");
    set(GROUND_ - 1, 68, "U");
    set(GROUND_ - 6, 80, "U");
    set(GROUND_ - 6, 74, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 36, "C");
    set(GROUND_ - 1, 62, "C");
    set(GROUND_ - 1, 84, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel56(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 22; c <= 70; c++) set(r, c, " ");
    setRect(GROUND_ - 7, 18, GROUND_ - 7, 74, "G");
    setRect(GROUND_ - 8, 18, GROUND_ - 8, 74, "D");
    set(GROUND_ - 1, 18, "U");
    set(GROUND_ - 6, 72, "U");
    set(GROUND_ - 6, 30, "C");
    set(GROUND_ - 6, 42, "C");
    set(GROUND_ - 6, 54, "C");
    set(GROUND_ - 6, 64, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 14, "C");
    set(GROUND_ - 1, 80, "C");
    set(GROUND_ - 1, 92, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel57(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 18; c <= 32; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 16, GROUND_ - 7, 36, "G");
    setRect(GROUND_ - 8, 16, GROUND_ - 8, 36, "D");
    set(GROUND_ - 6, 22, "X");
    set(GROUND_ - 6, 28, "X");
    set(GROUND_ - 1, 16, "U");
    set(GROUND_ - 6, 34, "U");
    set(GROUND_ - 6, 25, "C");
    set(GROUND_, 42, "B");
    set(GROUND_ - 1, 48, "X");
    for (var c2 = 56; c2 <= 80; c2++) set(GROUND_ - 1, c2, "X");
    setRect(GROUND_ - 7, 54, GROUND_ - 7, 84, "G");
    setRect(GROUND_ - 8, 54, GROUND_ - 8, 84, "D");
    set(GROUND_ - 6, 62, "X");
    set(GROUND_ - 6, 72, "X");
    set(GROUND_ - 1, 54, "U");
    set(GROUND_ - 6, 82, "U");
    set(GROUND_ - 6, 67, "C");
    set(GROUND_ - 6, 78, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 44, "C");
    set(GROUND_ - 1, 90, "C");
    set(GROUND_ - 1, 100, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel58(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 7, 16, GROUND_ - 7, 80, "G");
    setRect(GROUND_ - 8, 16, GROUND_ - 8, 80, "D");
    set(GROUND_ - 1, 18, "U");
    set(GROUND_ - 6, 78, "U");
    set(GROUND_ - 6, 28, "C");
    set(GROUND_ - 6, 42, "C");
    set(GROUND_ - 6, 56, "C");
    set(GROUND_ - 6, 70, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 88, "C");
    set(GROUND_ - 1, 100, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 100 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.2,
          w: 36, h: 36,
          cooldown: 220,
          initialDelay: 60,
        },
      ],
    };
  }

  function buildLevel59(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 22; c <= 50; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 20, GROUND_ - 7, 54, "G");
    setRect(GROUND_ - 8, 20, GROUND_ - 8, 54, "D");
    set(GROUND_ - 1, 20, "U");
    set(GROUND_ - 6, 52, "U");
    set(GROUND_ - 6, 30, "C");
    set(GROUND_ - 6, 42, "C");
    set(GROUND_ - 1, 60, "P");
    set(GROUND_ - 1, 96, "P");
    for (var r = GROUND_; r < ROWS; r++) for (var c4 = 70; c4 <= 78; c4++) set(r, c4, " ");
    set(GROUND_ - 1, 84, "X");
    set(GROUND_, 90, "B");
    set(GROUND_ - 1, 100, "S");
    setRect(GROUND_ - 2, 101, GROUND_ - 1, 101, "S");
    setRect(GROUND_ - 3, 102, GROUND_ - 1, 102, "S");
    setRect(GROUND_ - 4, 103, GROUND_ - 1, 103, "S");
    setRect(GROUND_ - 4, 104, GROUND_ - 4, 115, "G");
    setRect(GROUND_ - 3, 104, GROUND_ - 3, 115, "D");
    set(GROUND_ - 5, 110, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 16, "C");
    set(GROUND_ - 1, 64, "C");
    set(GROUND_ - 1, 120, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 70 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 70 * TILE,
        x1: 79 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.5,
      },
    ];
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: mv,
      boulders: [
        {
          spawnX: 130 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.4,
          w: 36, h: 36,
          cooldown: 240,
          initialDelay: 100,
        },
      ],
    };
  }

  function buildLevel60(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c1 = 14; c1 <= 26; c1++) set(GROUND_ - 1, c1, "X");
    setRect(GROUND_ - 7, 12, GROUND_ - 7, 30, "G");
    setRect(GROUND_ - 8, 12, GROUND_ - 8, 30, "D");
    set(GROUND_ - 1, 12, "U");
    set(GROUND_ - 6, 28, "U");
    set(GROUND_ - 6, 18, "C");
    set(GROUND_ - 6, 24, "C");
    set(GROUND_, 38, "B");
    for (var c2 = 46; c2 <= 70; c2++) set(GROUND_ - 1, c2, "X");
    setRect(GROUND_ - 7, 44, GROUND_ - 7, 74, "G");
    setRect(GROUND_ - 8, 44, GROUND_ - 8, 74, "D");
    set(GROUND_ - 1, 44, "U");
    set(GROUND_ - 6, 72, "U");
    set(GROUND_ - 6, 52, "C");
    set(GROUND_ - 6, 60, "C");
    set(GROUND_ - 6, 68, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 80, "C");
    set(GROUND_ - 1, 90, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel61(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 16; c <= 90; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 14, GROUND_ - 7, 94, "G");
    setRect(GROUND_ - 8, 14, GROUND_ - 8, 94, "D");
    set(GROUND_ - 6, 26, "X");
    set(GROUND_ - 6, 36, "X");
    set(GROUND_ - 6, 46, "X");
    set(GROUND_ - 6, 56, "X");
    set(GROUND_ - 6, 68, "X");
    set(GROUND_ - 6, 80, "X");
    set(GROUND_ - 1, 14, "U");
    set(GROUND_ - 6, 92, "U");
    set(GROUND_ - 6, 22, "C");
    set(GROUND_ - 6, 32, "C");
    set(GROUND_ - 6, 42, "C");
    set(GROUND_ - 6, 52, "C");
    set(GROUND_ - 6, 62, "C");
    set(GROUND_ - 6, 76, "C");
    set(GROUND_ - 6, 86, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 100, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel62(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 14; c <= 30; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 12, GROUND_ - 7, 34, "G");
    setRect(GROUND_ - 8, 12, GROUND_ - 8, 34, "D");
    set(GROUND_ - 1, 12, "U");
    set(GROUND_ - 6, 32, "U");
    set(GROUND_ - 6, 20, "C");
    set(GROUND_ - 6, 26, "C");
    set(GROUND_, 42, "B");
    set(GROUND_ - 1, 50, "X");
    set(GROUND_, 58, "B");
    for (var c2 = 66; c2 <= 96; c2++) set(GROUND_ - 1, c2, "X");
    setRect(GROUND_ - 7, 64, GROUND_ - 7, 100, "G");
    setRect(GROUND_ - 8, 64, GROUND_ - 8, 100, "D");
    set(GROUND_ - 1, 64, "U");
    set(GROUND_ - 6, 98, "U");
    set(GROUND_ - 6, 72, "C");
    set(GROUND_ - 6, 82, "C");
    set(GROUND_ - 6, 92, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 38, "C");
    set(GROUND_ - 1, 108, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return { spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 }, movers: [] };
  }

  function buildLevel63(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 30; c <= 70; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 28, GROUND_ - 7, 74, "G");
    setRect(GROUND_ - 8, 28, GROUND_ - 8, 74, "D");
    set(GROUND_ - 1, 28, "U");
    set(GROUND_ - 6, 72, "U");
    set(GROUND_ - 6, 38, "C");
    set(GROUND_ - 6, 50, "C");
    set(GROUND_ - 6, 64, "C");
    set(GROUND_ - 1, 84, "X");
    set(GROUND_, 90, "B");
    set(GROUND_ - 1, 100, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 16, "C");
    set(GROUND_ - 1, 80, "C");
    set(GROUND_ - 1, 110, "C");
    set(GROUND_ - 1, 120, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 125 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 240,
          initialDelay: 120,
        },
      ],
    };
  }

  function buildLevel64(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 18; c <= 20; c++) set(r, c, " ");
    for (var c2 = 28; c2 <= 60; c2++) set(GROUND_ - 1, c2, "X");
    setRect(GROUND_ - 7, 26, GROUND_ - 7, 64, "G");
    setRect(GROUND_ - 8, 26, GROUND_ - 8, 64, "D");
    set(GROUND_ - 6, 38, "X");
    set(GROUND_ - 6, 52, "X");
    set(GROUND_ - 1, 26, "U");
    set(GROUND_ - 6, 62, "U");
    set(GROUND_ - 6, 32, "C");
    set(GROUND_ - 6, 44, "C");
    set(GROUND_ - 6, 58, "C");
    set(GROUND_ - 1, 80, "P");
    set(GROUND_ - 1, 110, "P");
    set(GROUND_ - 1, 116, "S");
    setRect(GROUND_ - 2, 117, GROUND_ - 1, 117, "S");
    setRect(GROUND_ - 3, 118, GROUND_ - 1, 118, "S");
    setRect(GROUND_ - 4, 119, GROUND_ - 1, 119, "S");
    setRect(GROUND_ - 4, 120, GROUND_ - 4, 132, "G");
    setRect(GROUND_ - 3, 120, GROUND_ - 3, 132, "D");
    set(GROUND_ - 5, 126, "C");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 12, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 1, 90, "C");
    set(GROUND_ - 1, 100, "C");
    set(GROUND_ - 1, 138, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        axis: "y",
        x: 90 * TILE,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        y0: (GROUND_ - 4) * TILE,
        y1: GROUND_ * TILE,
        dir: -1,
        speed: 1.4,
      },
    ];
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: mv,
      boulders: [
        {
          spawnX: 145 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.4,
          w: 36, h: 36,
          cooldown: 220,
          initialDelay: 80,
        },
      ],
    };
  }

  function buildLevel65(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    set(GROUND_ - 1, 22, "X");
    set(GROUND_, 32, "B");
    set(GROUND_ - 1, 48, "X");
    set(GROUND_, 60, "B");
    set(GROUND_ - 1, 76, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 16, "C");
    set(GROUND_ - 1, 38, "C");
    set(GROUND_ - 1, 54, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 1, 86, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 95 * TILE,
          spawnY: (GROUND_ - 5) * TILE,
          speed: 2.4,
          accel: 0.10,
          cooldown: 360,
          initialDelay: 180,
        },
      ],
    };
  }

  function buildLevel66(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 30, GROUND_ - 1, 30, "S");
    setRect(GROUND_ - 3, 56, GROUND_ - 1, 56, "S");
    setRect(GROUND_ - 3, 82, GROUND_ - 1, 82, "S");
    set(GROUND_ - 1, 18, "X");
    set(GROUND_, 44, "B");
    set(GROUND_ - 1, 70, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 24, "C");
    set(GROUND_ - 1, 40, "C");
    set(GROUND_ - 1, 64, "C");
    set(GROUND_ - 1, 88, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 105 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.6,
          accel: 0.12,
          cooldown: 320,
          initialDelay: 120,
        },
      ],
    };
  }

  function buildLevel67(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 24, GROUND_ - 1, 24, "S");
    setRect(GROUND_ - 3, 50, GROUND_ - 1, 50, "S");
    setRect(GROUND_ - 3, 78, GROUND_ - 1, 78, "S");
    setRect(GROUND_ - 3, 104, GROUND_ - 1, 104, "S");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 36; c <= 38; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 90; c2 <= 92; c2++) set(r, c2, " ");
    set(GROUND_ - 1, 14, "X");
    set(GROUND_, 64, "B");
    set(GROUND_ - 1, 110, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 30, "C");
    set(GROUND_ - 1, 44, "C");
    set(GROUND_ - 1, 56, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 1, 84, "C");
    set(GROUND_ - 1, 98, "C");
    set(GROUND_ - 1, 116, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 115 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.5,
          accel: 0.11,
          cooldown: 280,
          initialDelay: 90,
        },
        {
          spawnX: 5 * TILE,
          spawnY: (GROUND_ - 7) * TILE,
          speed: 2.3,
          accel: 0.09,
          cooldown: 360,
          initialDelay: 240,
        },
      ],
    };
  }

  function buildLevel68(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 22; c <= 60; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 20, GROUND_ - 7, 64, "G");
    setRect(GROUND_ - 8, 20, GROUND_ - 8, 64, "D");
    set(GROUND_ - 1, 20, "U");
    set(GROUND_ - 6, 62, "U");
    set(GROUND_ - 6, 30, "C");
    set(GROUND_ - 6, 42, "C");
    set(GROUND_ - 6, 54, "C");
    setRect(GROUND_ - 3, 80, GROUND_ - 1, 80, "S");
    setRect(GROUND_ - 3, 100, GROUND_ - 1, 100, "S");
    set(GROUND_ - 1, 90, "X");
    set(GROUND_, 110, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 14, "C");
    set(GROUND_ - 1, 72, "C");
    set(GROUND_ - 1, 86, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 1, 116, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 120 * TILE,
          spawnY: (GROUND_ - 5) * TILE,
          speed: 2.7,
          accel: 0.12,
          cooldown: 280,
          initialDelay: 200,
        },
      ],
    };
  }

  function buildLevel69(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 24, GROUND_ - 1, 24, "S");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 36; c <= 44; c++) set(r, c, " ");
    setRect(GROUND_ - 3, 60, GROUND_ - 1, 60, "S");
    set(GROUND_ - 1, 70, "P");
    set(GROUND_ - 1, 110, "P");
    for (var c2 = 80; c2 <= 100; c2++) set(GROUND_ - 1, c2, "X");
    setRect(GROUND_ - 7, 78, GROUND_ - 7, 104, "G");
    setRect(GROUND_ - 8, 78, GROUND_ - 8, 104, "D");
    set(GROUND_ - 1, 78, "U");
    set(GROUND_ - 6, 102, "U");
    set(GROUND_ - 6, 86, "C");
    set(GROUND_ - 6, 94, "C");
    setRect(GROUND_ - 3, 120, GROUND_ - 1, 120, "S");
    set(GROUND_ - 1, 130, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 14, "C");
    set(GROUND_ - 1, 32, "C");
    set(GROUND_ - 1, 52, "C");
    set(GROUND_ - 1, 66, "C");
    set(GROUND_ - 1, 116, "C");
    set(GROUND_ - 1, 138, "C");
    set(GROUND_ - 1, ec - 2, "E");
    var mv = [
      {
        x: 36 * TILE - 8,
        y: GROUND_ * TILE,
        w: TILE * 2,
        h: 16,
        x0: 36 * TILE,
        x1: 45 * TILE - TILE * 2 + 8,
        dir: 1,
        speed: 1.55,
      },
    ];
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: mv,
      missiles: [
        {
          spawnX: 145 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.8,
          accel: 0.13,
          cooldown: 260,
          initialDelay: 100,
        },
        {
          spawnX: 8 * TILE,
          spawnY: (GROUND_ - 7) * TILE,
          speed: 2.5,
          accel: 0.10,
          cooldown: 320,
          initialDelay: 280,
        },
      ],
    };
  }

  function buildLevel70(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 24, GROUND_ - 1, 24, "S");
    setRect(GROUND_ - 3, 50, GROUND_ - 1, 50, "S");
    setRect(GROUND_ - 3, 78, GROUND_ - 1, 78, "S");
    set(GROUND_ - 1, 14, "X");
    set(GROUND_, 38, "B");
    set(GROUND_ - 1, 64, "X");
    set(GROUND_, 90, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 18, "C");
    set(GROUND_ - 1, 32, "C");
    set(GROUND_ - 1, 44, "C");
    set(GROUND_ - 1, 58, "C");
    set(GROUND_ - 1, 72, "C");
    set(GROUND_ - 1, 86, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 105 * TILE,
          spawnY: (GROUND_ - 5) * TILE,
          speed: 2.8, accel: 0.13,
          cooldown: 240, initialDelay: 100,
        },
        {
          spawnX: 105 * TILE,
          spawnY: (GROUND_ - 8) * TILE,
          speed: 2.6, accel: 0.11,
          cooldown: 280, initialDelay: 220,
        },
      ],
    };
  }

  function buildLevel71(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 28, GROUND_ - 1, 28, "S");
    setRect(GROUND_ - 3, 56, GROUND_ - 1, 56, "S");
    setRect(GROUND_ - 3, 88, GROUND_ - 1, 88, "S");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 70; c <= 72; c++) set(r, c, " ");
    set(GROUND_ - 1, 18, "X");
    set(GROUND_, 42, "B");
    set(GROUND_ - 1, 80, "X");
    set(GROUND_, 100, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 22, "C");
    set(GROUND_ - 1, 36, "C");
    set(GROUND_ - 1, 50, "C");
    set(GROUND_ - 1, 64, "C");
    set(GROUND_ - 1, 76, "C");
    set(GROUND_ - 1, 94, "C");
    set(GROUND_ - 1, 108, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 115 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.9, accel: 0.13,
          cooldown: 240, initialDelay: 80,
        },
        {
          spawnX: 5 * TILE,
          spawnY: (GROUND_ - 7) * TILE,
          speed: 2.7, accel: 0.12,
          cooldown: 260, initialDelay: 200,
        },
      ],
    };
  }

  function buildLevel72(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 22, GROUND_ - 1, 22, "S");
    setRect(GROUND_ - 3, 46, GROUND_ - 1, 46, "S");
    setRect(GROUND_ - 3, 72, GROUND_ - 1, 72, "S");
    setRect(GROUND_ - 3, 100, GROUND_ - 1, 100, "S");
    for (var c = 32; c <= 38; c++) set(GROUND_ - 1, c, "X");
    set(GROUND_ - 2, 33, "S");
    set(GROUND_ - 2, 35, "S");
    set(GROUND_ - 2, 37, "S");
    for (var c2 = 84; c2 <= 90; c2++) set(GROUND_ - 1, c2, "X");
    set(GROUND_ - 2, 85, "S");
    set(GROUND_ - 2, 87, "S");
    set(GROUND_ - 2, 89, "S");
    set(GROUND_, 60, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 16, "C");
    set(GROUND_ - 1, 28, "C");
    set(GROUND_ - 1, 42, "C");
    set(GROUND_ - 1, 54, "C");
    set(GROUND_ - 1, 68, "C");
    set(GROUND_ - 1, 80, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 1, 110, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 130 * TILE,
          spawnY: (GROUND_ - 5) * TILE,
          speed: 3.0, accel: 0.14,
          cooldown: 220, initialDelay: 60,
        },
        {
          spawnX: 130 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.7, accel: 0.12,
          cooldown: 260, initialDelay: 180,
        },
        {
          spawnX: 5 * TILE,
          spawnY: (GROUND_ - 8) * TILE,
          speed: 2.5, accel: 0.10,
          cooldown: 320, initialDelay: 320,
        },
      ],
    };
  }

  function buildLevel73(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 28; c <= 60; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 26, GROUND_ - 7, 64, "G");
    setRect(GROUND_ - 8, 26, GROUND_ - 8, 64, "D");
    set(GROUND_ - 1, 26, "U");
    set(GROUND_ - 6, 62, "U");
    set(GROUND_ - 6, 36, "C");
    set(GROUND_ - 6, 48, "C");
    set(GROUND_ - 6, 58, "C");
    setRect(GROUND_ - 3, 76, GROUND_ - 1, 76, "S");
    setRect(GROUND_ - 3, 100, GROUND_ - 1, 100, "S");
    set(GROUND_ - 1, 90, "X");
    set(GROUND_, 110, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 14, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 1, 82, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 1, 116, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 125 * TILE,
          spawnY: (GROUND_ - 5) * TILE,
          speed: 3.0, accel: 0.14,
          cooldown: 240, initialDelay: 100,
        },
        {
          spawnX: 125 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 260,
        },
      ],
    };
  }

  function buildLevel74(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 30; c <= 32; c++) set(r, c, " ");
    setRect(GROUND_ - 3, 18, GROUND_ - 1, 18, "S");
    setRect(GROUND_ - 3, 44, GROUND_ - 1, 44, "S");
    set(GROUND_ - 1, 60, "P");
    set(GROUND_ - 1, 100, "P");
    for (var c2 = 70; c2 <= 90; c2++) set(GROUND_ - 1, c2, "X");
    setRect(GROUND_ - 7, 68, GROUND_ - 7, 94, "G");
    setRect(GROUND_ - 8, 68, GROUND_ - 8, 94, "D");
    set(GROUND_ - 1, 68, "U");
    set(GROUND_ - 6, 92, "U");
    set(GROUND_ - 6, 78, "C");
    set(GROUND_ - 6, 86, "C");
    setRect(GROUND_ - 3, 110, GROUND_ - 1, 110, "S");
    setRect(GROUND_ - 3, 130, GROUND_ - 1, 130, "S");
    set(GROUND_ - 1, 122, "X");
    set(GROUND_, 138, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 14, "C");
    set(GROUND_ - 1, 26, "C");
    set(GROUND_ - 1, 50, "C");
    set(GROUND_ - 1, 64, "C");
    set(GROUND_ - 1, 104, "C");
    set(GROUND_ - 1, 116, "C");
    set(GROUND_ - 1, 144, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 155 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 3.0, accel: 0.13,
          cooldown: 240, initialDelay: 120,
        },
        {
          spawnX: 155 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 280,
        },
        {
          spawnX: 5 * TILE,
          spawnY: (GROUND_ - 8) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 360, initialDelay: 420,
        },
      ],
    };
  }

  function buildLevel75(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 12, GROUND_ - 1, 12, "S");
    setRect(GROUND_ - 3, 24, GROUND_ - 1, 24, "S");
    set(GROUND_, 32, "B");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 44; c <= 46; c++) set(r, c, " ");
    for (r = GROUND_; r < ROWS; r++) for (var c2 = 60; c2 <= 62; c2++) set(r, c2, " ");
    setRect(GROUND_ - 3, 80, GROUND_ - 1, 80, "S");
    setRect(GROUND_ - 3, 92, GROUND_ - 1, 92, "S");
    setRect(GROUND_ - 3, 104, GROUND_ - 1, 104, "S");
    setRect(GROUND_ - 3, 116, GROUND_ - 1, 116, "S");
    set(GROUND_ - 1, 86, "X");
    set(GROUND_ - 1, 98, "X");
    set(GROUND_, 110, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 12, "C");
    set(GROUND_ - 4, 24, "C");
    set(GROUND_ - 1, 38, "C");
    set(GROUND_ - 1, 52, "C");
    set(GROUND_ - 1, 68, "C");
    set(GROUND_ - 1, 76, "C");
    set(GROUND_ - 1, 88, "C");
    set(GROUND_ - 1, 100, "C");
    set(GROUND_ - 1, 122, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 70 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.4,
          w: 36, h: 36,
          cooldown: 220,
          initialDelay: 80,
        },
      ],
      missiles: [
        {
          spawnX: 125 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 3.0, accel: 0.14,
          cooldown: 230, initialDelay: 120,
        },
        {
          spawnX: 125 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 260,
        },
      ],
    };
  }

  function buildLevel76(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 12; c <= 19; c++) set(GROUND_ - 1, c, "X");
    set(GROUND_ - 2, 13, "S");
    set(GROUND_ - 2, 15, "S");
    set(GROUND_ - 2, 17, "S");
    set(GROUND_ - 2, 19, "S");
    setRect(GROUND_ - 7, 26, GROUND_ - 7, 80, "G");
    setRect(GROUND_ - 8, 26, GROUND_ - 8, 80, "D");
    for (var c2 = 28; c2 <= 76; c2++) set(GROUND_ - 1, c2, "X");
    set(GROUND_ - 1, 26, "U");
    set(GROUND_ - 6, 78, "U");
    set(GROUND_ - 6, 36, "C");
    set(GROUND_ - 6, 48, "C");
    set(GROUND_ - 6, 60, "C");
    set(GROUND_ - 6, 72, "C");
    setRect(GROUND_ - 3, 92, GROUND_ - 1, 92, "S");
    setRect(GROUND_ - 3, 104, GROUND_ - 1, 104, "S");
    setRect(GROUND_ - 3, 118, GROUND_ - 1, 118, "S");
    setRect(GROUND_ - 3, 130, GROUND_ - 1, 130, "S");
    set(GROUND_ - 1, 98, "X");
    set(GROUND_ - 1, 112, "X");
    set(GROUND_, 124, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 84, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 1, 108, "C");
    set(GROUND_ - 1, 122, "C");
    set(GROUND_ - 1, 134, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 80 * TILE,
          spawnY: (GROUND_ - 4) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 300, initialDelay: 200,
        },
        {
          spawnX: 135 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 3.0, accel: 0.13,
          cooldown: 230, initialDelay: 100,
        },
        {
          spawnX: 135 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 280,
        },
      ],
    };
  }

  function buildLevel77(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    addVineColumn(set, setRect, GROUND_, 16, 17, 22);
    setRect(GROUND_ - 7, 22, GROUND_ - 7, 78, "G");
    setRect(GROUND_ - 6, 22, GROUND_ - 6, 78, "D");
    set(GROUND_ - 8, 30, "C");
    set(GROUND_ - 8, 42, "C");
    set(GROUND_ - 8, 54, "C");
    set(GROUND_ - 8, 66, "C");
    setRect(GROUND_ - 5, 82, GROUND_ - 5, 86, "F");
    setRect(GROUND_ - 3, 90, GROUND_ - 3, 94, "F");
    set(GROUND_ - 6, 84, "C");
    set(GROUND_ - 4, 92, "C");
    setRect(GROUND_ - 3, 102, GROUND_ - 1, 102, "S");
    setRect(GROUND_ - 3, 114, GROUND_ - 1, 114, "S");
    setRect(GROUND_ - 3, 124, GROUND_ - 1, 124, "S");
    set(GROUND_ - 1, 108, "X");
    set(GROUND_ - 1, 120, "X");
    set(GROUND_, 100, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 12, "C");
    set(GROUND_ - 1, 98, "C");
    set(GROUND_ - 1, 112, "C");
    set(GROUND_ - 1, 126, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 74 * TILE,
          y: (GROUND_ - 7) * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 220,
          initialDelay: 80,
        },
        {
          spawnX: 74 * TILE,
          y: (GROUND_ - 7) * TILE - 18,
          vx: -2.6,
          w: 32, h: 32,
          cooldown: 280,
          initialDelay: 240,
        },
      ],
      missiles: [
        {
          spawnX: 128 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 3.0, accel: 0.13,
          cooldown: 240, initialDelay: 100,
        },
      ],
    };
  }

  function buildLevel78(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 10, GROUND_ - 1, 10, "S");
    setRect(GROUND_ - 3, 22, GROUND_ - 1, 22, "S");
    set(GROUND_, 16, "B");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 32; c <= 50; c++) set(r, c, " ");
    set(GROUND_ - 1, 28, "P");
    set(GROUND_ - 1, 56, "P");
    setRect(GROUND_ - 7, 64, GROUND_ - 7, 110, "G");
    setRect(GROUND_ - 8, 64, GROUND_ - 8, 110, "D");
    for (var c3 = 66; c3 <= 106; c3++) set(GROUND_ - 1, c3, "X");
    set(GROUND_ - 1, 64, "U");
    set(GROUND_ - 6, 108, "U");
    set(GROUND_ - 6, 74, "C");
    set(GROUND_ - 6, 84, "C");
    set(GROUND_ - 6, 94, "C");
    set(GROUND_ - 6, 104, "C");
    setRect(GROUND_ - 3, 118, GROUND_ - 1, 118, "S");
    setRect(GROUND_ - 3, 130, GROUND_ - 1, 130, "S");
    setRect(GROUND_ - 3, 140, GROUND_ - 1, 140, "S");
    set(GROUND_ - 1, 124, "X");
    set(GROUND_ - 1, 136, "X");
    set(GROUND_, 144, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 10, "C");
    set(GROUND_ - 4, 22, "C");
    set(GROUND_ - 1, 60, "C");
    set(GROUND_ - 1, 114, "C");
    set(GROUND_ - 1, 122, "C");
    set(GROUND_ - 1, 134, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 110 * TILE,
          spawnY: (GROUND_ - 4) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 300, initialDelay: 220,
        },
        {
          spawnX: 145 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 3.0, accel: 0.14,
          cooldown: 230, initialDelay: 80,
        },
        {
          spawnX: 145 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 260,
        },
      ],
    };
  }

  function buildLevel79(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 10, GROUND_ - 1, 10, "S");
    setRect(GROUND_ - 3, 22, GROUND_ - 1, 22, "S");
    set(GROUND_, 16, "B");
    addVineColumn(set, setRect, GROUND_, 28, 29, 34);
    setRect(GROUND_ - 4, 38, GROUND_ - 4, 42, "F");
    setRect(GROUND_ - 5, 46, GROUND_ - 5, 50, "F");
    set(GROUND_ - 5, 40, "C");
    set(GROUND_ - 6, 48, "C");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 56; c <= 58; c++) set(r, c, " ");
    set(GROUND_ - 1, 64, "X");
    set(GROUND_ - 1, 68, "X");
    set(GROUND_ - 1, 72, "X");
    set(GROUND_, 76, "B");
    setRect(GROUND_ - 7, 82, GROUND_ - 7, 124, "G");
    setRect(GROUND_ - 8, 82, GROUND_ - 8, 124, "D");
    for (var c2 = 84; c2 <= 122; c2++) set(GROUND_ - 1, c2, "X");
    set(GROUND_ - 1, 82, "U");
    set(GROUND_ - 6, 124, "U");
    set(GROUND_ - 6, 92, "C");
    set(GROUND_ - 6, 102, "C");
    set(GROUND_ - 6, 112, "C");
    set(GROUND_ - 6, 120, "C");
    for (var r2 = GROUND_; r2 < ROWS; r2++) for (var c3 = 134; c3 <= 142; c3++) set(r2, c3, " ");
    set(GROUND_ - 1, 132, "P");
    set(GROUND_ - 1, 144, "P");
    setRect(GROUND_ - 3, 158, GROUND_ - 1, 158, "S");
    setRect(GROUND_ - 3, 168, GROUND_ - 1, 168, "S");
    set(GROUND_ - 1, 162, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 10, "C");
    set(GROUND_ - 4, 22, "C");
    set(GROUND_ - 8, 32, "C");
    set(GROUND_ - 1, 54, "C");
    set(GROUND_ - 1, 80, "C");
    set(GROUND_ - 1, 128, "C");
    set(GROUND_ - 1, 154, "C");
    set(GROUND_ - 1, 174, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 78 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.2,
          w: 36, h: 36,
          cooldown: 240,
          initialDelay: 100,
        },
      ],
      missiles: [
        {
          spawnX: 175 * TILE,
          spawnY: (GROUND_ - 5) * TILE,
          speed: 3.0, accel: 0.14,
          cooldown: 230, initialDelay: 100,
        },
        {
          spawnX: 175 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 260,
        },
        {
          spawnX: 5 * TILE,
          spawnY: (GROUND_ - 8) * TILE,
          speed: 2.5, accel: 0.10,
          cooldown: 360, initialDelay: 420,
        },
      ],
    };
  }

  function buildLevel80(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 22; c <= 24; c++) set(r, c, " ");
    for (var r2 = GROUND_; r2 < ROWS; r2++) for (var c2 = 44; c2 <= 46; c2++) set(r2, c2, " ");
    set(GROUND_ - 1, 32, "X");
    set(GROUND_, 56, "B");
    setRect(GROUND_ - 3, 64, GROUND_ - 1, 64, "S");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 16, "C");
    set(GROUND_ - 1, 28, "C");
    set(GROUND_ - 1, 38, "C");
    set(GROUND_ - 1, 50, "C");
    set(GROUND_ - 4, 64, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 1, 76, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      reversers: { minDelay: 240, maxDelay: 420, initialDelay: 150 },
    };
  }

  function buildLevel81(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 18; c <= 21; c++) set(r, c, " ");
    for (var r2 = GROUND_; r2 < ROWS; r2++) for (var c2 = 36; c2 <= 39; c2++) set(r2, c2, " ");
    for (var r3 = GROUND_; r3 < ROWS; r3++) for (var c3 = 56; c3 <= 59; c3++) set(r3, c3, " ");
    setRect(GROUND_ - 3, 28, GROUND_ - 1, 28, "S");
    set(GROUND_ - 1, 46, "X");
    setRect(GROUND_ - 3, 66, GROUND_ - 1, 66, "S");
    set(GROUND_, 74, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 14, "C");
    set(GROUND_ - 4, 28, "C");
    set(GROUND_ - 1, 32, "C");
    set(GROUND_ - 1, 42, "C");
    set(GROUND_ - 1, 50, "C");
    set(GROUND_ - 1, 62, "C");
    set(GROUND_ - 4, 66, "C");
    set(GROUND_ - 1, 80, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      reversers: { minDelay: 200, maxDelay: 360, initialDelay: 120 },
    };
  }

  function buildLevel82(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 14, GROUND_ - 1, 14, "S");
    setRect(GROUND_ - 3, 26, GROUND_ - 1, 26, "S");
    set(GROUND_ - 1, 22, "X");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 36; c <= 39; c++) set(r, c, " ");
    setRect(GROUND_ - 3, 48, GROUND_ - 1, 48, "S");
    set(GROUND_, 56, "B");
    setRect(GROUND_ - 3, 64, GROUND_ - 1, 64, "S");
    set(GROUND_ - 1, 72, "X");
    setRect(GROUND_ - 3, 80, GROUND_ - 1, 80, "S");
    set(GROUND_, 88, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 14, "C");
    set(GROUND_ - 1, 18, "C");
    set(GROUND_ - 4, 26, "C");
    set(GROUND_ - 1, 32, "C");
    set(GROUND_ - 1, 44, "C");
    set(GROUND_ - 4, 48, "C");
    set(GROUND_ - 4, 64, "C");
    set(GROUND_ - 4, 80, "C");
    set(GROUND_ - 1, 84, "C");
    set(GROUND_ - 1, 92, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      reversers: { minDelay: 180, maxDelay: 320, initialDelay: 100 },
    };
  }

  function buildLevel83(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 24; c <= 26; c++) set(r, c, " ");
    for (var r2 = GROUND_; r2 < ROWS; r2++) for (var c2 = 50; c2 <= 53; c2++) set(r2, c2, " ");
    for (var r3 = GROUND_; r3 < ROWS; r3++) for (var c3 = 78; c3 <= 80; c3++) set(r3, c3, " ");
    setRect(GROUND_ - 3, 14, GROUND_ - 1, 14, "S");
    set(GROUND_ - 1, 32, "X");
    setRect(GROUND_ - 3, 38, GROUND_ - 1, 38, "S");
    set(GROUND_, 44, "B");
    setRect(GROUND_ - 3, 60, GROUND_ - 1, 60, "S");
    set(GROUND_ - 1, 70, "X");
    setRect(GROUND_ - 3, 86, GROUND_ - 1, 86, "S");
    set(GROUND_, 96, "B");
    setRect(GROUND_ - 3, 102, GROUND_ - 1, 102, "S");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 14, "C");
    set(GROUND_ - 1, 20, "C");
    set(GROUND_ - 1, 30, "C");
    set(GROUND_ - 4, 38, "C");
    set(GROUND_ - 1, 48, "C");
    set(GROUND_ - 4, 60, "C");
    set(GROUND_ - 1, 66, "C");
    set(GROUND_ - 1, 74, "C");
    set(GROUND_ - 4, 86, "C");
    set(GROUND_ - 1, 92, "C");
    set(GROUND_ - 4, 102, "C");
    set(GROUND_ - 1, 106, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      reversers: { minDelay: 180, maxDelay: 320, initialDelay: 100 },
    };
  }

  function buildLevel84(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 16, GROUND_ - 1, 16, "S");
    set(GROUND_ - 1, 24, "X");
    setRect(GROUND_ - 3, 32, GROUND_ - 1, 32, "S");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 42; c <= 45; c++) set(r, c, " ");
    setRect(GROUND_ - 3, 54, GROUND_ - 1, 54, "S");
    set(GROUND_, 62, "B");
    setRect(GROUND_ - 3, 70, GROUND_ - 1, 70, "S");
    set(GROUND_ - 1, 80, "X");
    setRect(GROUND_ - 3, 88, GROUND_ - 1, 88, "S");
    setRect(GROUND_ - 3, 100, GROUND_ - 1, 100, "S");
    setRect(GROUND_ - 3, 112, GROUND_ - 1, 112, "S");
    set(GROUND_, 120, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 16, "C");
    set(GROUND_ - 1, 20, "C");
    set(GROUND_ - 4, 32, "C");
    set(GROUND_ - 1, 38, "C");
    set(GROUND_ - 1, 50, "C");
    set(GROUND_ - 4, 54, "C");
    set(GROUND_ - 4, 70, "C");
    set(GROUND_ - 1, 76, "C");
    set(GROUND_ - 4, 88, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 4, 100, "C");
    set(GROUND_ - 4, 112, "C");
    set(GROUND_ - 1, 124, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      missiles: [
        {
          spawnX: 125 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 220,
        },
      ],
      reversers: { minDelay: 180, maxDelay: 300, initialDelay: 100 },
    };
  }

  function buildLevel85(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    addVineColumn(set, setRect, GROUND_, 18, 19, 24);
    addVineColumn(set, setRect, GROUND_, 40, 41, 46);
    for (var r = GROUND_; r < ROWS; r++) for (var c = 56; c <= 58; c++) set(r, c, " ");
    set(GROUND_ - 1, 64, "X");
    setRect(GROUND_ - 3, 72, GROUND_ - 1, 72, "S");
    set(GROUND_, 80, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 8, 22, "C");
    set(GROUND_ - 1, 32, "C");
    set(GROUND_ - 8, 44, "C");
    set(GROUND_ - 1, 52, "C");
    set(GROUND_ - 1, 62, "C");
    set(GROUND_ - 4, 72, "C");
    set(GROUND_ - 1, 86, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 80 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -2.8,
          w: 36, h: 36,
          cooldown: 280,
          initialDelay: 160,
        },
      ],
      missiles: [
        {
          spawnX: 85 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 200,
        },
      ],
      reversers: { minDelay: 220, maxDelay: 360, initialDelay: 150 },
    };
  }

  function buildLevel86(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    addVineColumn(set, setRect, GROUND_, 22, 23, 30);
    addVineColumn(set, setRect, GROUND_, 56, 57, 64);
    set(GROUND_ - 1, 36, "X");
    set(GROUND_ - 1, 44, "X");
    setRect(GROUND_ - 3, 72, GROUND_ - 1, 72, "S");
    set(GROUND_, 82, "B");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 14, "C");
    set(GROUND_ - 8, 26, "C");
    set(GROUND_ - 1, 40, "C");
    set(GROUND_ - 1, 50, "C");
    set(GROUND_ - 8, 60, "C");
    set(GROUND_ - 4, 72, "C");
    set(GROUND_ - 1, 88, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 90 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 260,
          initialDelay: 120,
        },
        {
          spawnX: 90 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -2.4,
          w: 32, h: 32,
          cooldown: 320,
          initialDelay: 320,
        },
      ],
      missiles: [
        {
          spawnX: 95 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 220,
        },
      ],
      reversers: { minDelay: 200, maxDelay: 340, initialDelay: 140 },
    };
  }

  function buildLevel87(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    addVineColumn(set, setRect, GROUND_, 16, 17, 22);
    addVineColumn(set, setRect, GROUND_, 38, 39, 44);
    addVineColumn(set, setRect, GROUND_, 62, 63, 68);
    setRect(GROUND_ - 7, 22, GROUND_ - 7, 39, "G");
    setRect(GROUND_ - 6, 22, GROUND_ - 6, 39, "D");
    setRect(GROUND_ - 7, 44, GROUND_ - 7, 63, "G");
    setRect(GROUND_ - 6, 44, GROUND_ - 6, 63, "D");
    set(GROUND_ - 1, 30, "X");
    set(GROUND_, 50, "B");
    set(GROUND_ - 1, 76, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 8, 28, "C");
    set(GROUND_ - 1, 36, "C");
    set(GROUND_ - 8, 50, "C");
    set(GROUND_ - 1, 56, "C");
    set(GROUND_ - 8, 66, "C");
    set(GROUND_ - 1, 72, "C");
    set(GROUND_ - 1, 82, "C");
    set(GROUND_ - 1, 90, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 92 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -2.8,
          w: 36, h: 36,
          cooldown: 280,
          initialDelay: 180,
        },
      ],
      missiles: [
        {
          spawnX: 95 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 200,
        },
      ],
      reversers: { minDelay: 200, maxDelay: 320, initialDelay: 120 },
    };
  }

  function buildLevel88(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    addVineColumn(set, setRect, GROUND_, 14, 15, 22);
    addVineColumn(set, setRect, GROUND_, 36, 37, 46);
    addVineColumn(set, setRect, GROUND_, 60, 61, 68);
    addVineColumn(set, setRect, GROUND_, 84, 85, 92);
    set(GROUND_ - 1, 28, "X");
    set(GROUND_, 32, "B");
    set(GROUND_ - 1, 52, "X");
    set(GROUND_ - 1, 76, "X");
    setRect(GROUND_ - 3, 100, GROUND_ - 1, 100, "S");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 8, 18, "C");
    set(GROUND_ - 8, 40, "C");
    set(GROUND_ - 1, 48, "C");
    set(GROUND_ - 8, 64, "C");
    set(GROUND_ - 1, 72, "C");
    set(GROUND_ - 8, 88, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 4, 100, "C");
    set(GROUND_ - 1, 106, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 108 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.2,
          w: 36, h: 36,
          cooldown: 260,
          initialDelay: 120,
        },
      ],
      missiles: [
        {
          spawnX: 108 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.8, accel: 0.12,
          cooldown: 260, initialDelay: 180,
        },
        {
          spawnX: 108 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 320,
        },
      ],
      reversers: { minDelay: 180, maxDelay: 280, initialDelay: 100 },
    };
  }

  function buildLevel89(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    addVineColumn(set, setRect, GROUND_, 16, 17, 24);
    addVineColumn(set, setRect, GROUND_, 44, 45, 52);
    addVineColumn(set, setRect, GROUND_, 76, 77, 84);
    set(GROUND_ - 1, 30, "X");
    set(GROUND_, 38, "B");
    set(GROUND_ - 1, 60, "X");
    setRect(GROUND_ - 3, 96, GROUND_ - 1, 96, "S");
    set(GROUND_, 108, "B");
    setRect(GROUND_ - 3, 116, GROUND_ - 1, 116, "S");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 8, 20, "C");
    set(GROUND_ - 1, 34, "C");
    set(GROUND_ - 8, 48, "C");
    set(GROUND_ - 1, 56, "C");
    set(GROUND_ - 1, 70, "C");
    set(GROUND_ - 8, 80, "C");
    set(GROUND_ - 1, 90, "C");
    set(GROUND_ - 4, 96, "C");
    set(GROUND_ - 4, 116, "C");
    set(GROUND_ - 1, 124, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 130 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.2,
          w: 36, h: 36,
          cooldown: 260,
          initialDelay: 140,
        },
        {
          spawnX: 130 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -2.6,
          w: 32, h: 32,
          cooldown: 320,
          initialDelay: 360,
        },
      ],
      missiles: [
        {
          spawnX: 128 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.8, accel: 0.12,
          cooldown: 260, initialDelay: 160,
        },
        {
          spawnX: 128 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 300,
        },
      ],
      reversers: { minDelay: 160, maxDelay: 280, initialDelay: 110 },
    };
  }

  function buildLevel90(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 16, GROUND_ - 3, 20, "F");
    setRect(GROUND_ - 3, 26, GROUND_ - 3, 30, "F");
    setRect(GROUND_ - 3, 36, GROUND_ - 3, 40, "F");
    set(GROUND_ - 1, 56, "X");
    setRect(GROUND_ - 3, 64, GROUND_ - 1, 64, "S");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 18, "C");
    set(GROUND_ - 4, 28, "C");
    set(GROUND_ - 4, 38, "C");
    set(GROUND_ - 1, 52, "C");
    set(GROUND_ - 4, 64, "C");
    set(GROUND_ - 1, 76, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [
        {
          axis: "y",
          x: 70 * TILE,
          y: GROUND_ * TILE,
          w: TILE * 2,
          h: 16,
          y0: (GROUND_ - 4) * TILE,
          y1: GROUND_ * TILE,
          dir: -1,
          speed: 1.4,
        },
      ],
      boulders: [
        {
          spawnX: 80 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -2.6,
          w: 36, h: 36,
          cooldown: 320,
          initialDelay: 200,
        },
      ],
      missiles: [
        {
          spawnX: 82 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 200,
        },
      ],
    };
  }

  function buildLevel91(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 14, GROUND_ - 1, 14, "S");
    set(GROUND_ - 1, 24, "X");
    setRect(GROUND_ - 3, 34, GROUND_ - 1, 34, "S");
    set(GROUND_, 46, "B");
    setRect(GROUND_ - 3, 56, GROUND_ - 1, 56, "S");
    setRect(GROUND_ - 3, 76, GROUND_ - 1, 76, "S");
    set(GROUND_ - 1, 86, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 14, "C");
    set(GROUND_ - 1, 20, "C");
    set(GROUND_ - 4, 34, "C");
    set(GROUND_ - 1, 42, "C");
    set(GROUND_ - 4, 56, "C");
    set(GROUND_ - 1, 66, "C");
    set(GROUND_ - 4, 76, "C");
    set(GROUND_ - 1, 92, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 95 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 280,
          initialDelay: 100,
        },
      ],
      missiles: [
        {
          spawnX: 95 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 260, initialDelay: 140,
        },
        {
          spawnX: 95 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 280,
        },
      ],
    };
  }

  function buildLevel92(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 28; c <= 70; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 26, GROUND_ - 7, 72, "G");
    setRect(GROUND_ - 8, 26, GROUND_ - 8, 72, "D");
    set(GROUND_ - 1, 26, "U");
    set(GROUND_ - 6, 70, "U");
    set(GROUND_ - 6, 36, "C");
    set(GROUND_ - 6, 48, "C");
    set(GROUND_ - 6, 60, "C");
    setRect(GROUND_ - 3, 80, GROUND_ - 1, 80, "S");
    set(GROUND_ - 1, 90, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 16, "C");
    set(GROUND_ - 1, 78, "C");
    set(GROUND_ - 4, 80, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 100 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 280,
          initialDelay: 240,
        },
      ],
      missiles: [
        {
          spawnX: 100 * TILE,
          spawnY: (GROUND_ - 5) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 160,
        },
        {
          spawnX: 100 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 320,
        },
      ],
    };
  }

  function buildLevel93(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 14, GROUND_ - 3, 18, "F");
    setRect(GROUND_ - 4, 22, GROUND_ - 4, 26, "F");
    setRect(GROUND_ - 5, 30, GROUND_ - 5, 34, "F");
    setRect(GROUND_ - 6, 38, GROUND_ - 6, 42, "F");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 16, "C");
    set(GROUND_ - 5, 24, "C");
    set(GROUND_ - 6, 32, "C");
    set(GROUND_ - 7, 40, "C");
    set(GROUND_ - 1, 64, "C");
    set(GROUND_ - 1, 74, "C");
    set(GROUND_ - 1, 86, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 95 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -2.8,
          w: 36, h: 36,
          cooldown: 300,
          initialDelay: 220,
        },
      ],
      missiles: [
        {
          spawnX: 95 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 280, initialDelay: 140,
        },
        {
          spawnX: 95 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 280,
        },
      ],
    };
  }

  function buildLevel94(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 14, GROUND_ - 1, 14, "S");
    set(GROUND_ - 1, 22, "X");
    setRect(GROUND_ - 3, 30, GROUND_ - 1, 30, "S");
    setRect(GROUND_ - 3, 46, GROUND_ - 1, 46, "S");
    set(GROUND_, 56, "B");
    setRect(GROUND_ - 3, 64, GROUND_ - 1, 64, "S");
    set(GROUND_ - 1, 74, "X");
    setRect(GROUND_ - 3, 82, GROUND_ - 1, 82, "S");
    setRect(GROUND_ - 3, 96, GROUND_ - 1, 96, "S");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 14, "C");
    set(GROUND_ - 4, 30, "C");
    set(GROUND_ - 1, 38, "C");
    set(GROUND_ - 4, 46, "C");
    set(GROUND_ - 4, 64, "C");
    set(GROUND_ - 4, 82, "C");
    set(GROUND_ - 1, 90, "C");
    set(GROUND_ - 4, 96, "C");
    set(GROUND_ - 1, 106, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 110 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 280,
          initialDelay: 180,
        },
      ],
      missiles: [
        {
          spawnX: 110 * TILE,
          spawnY: (GROUND_ - 5) * TILE,
          speed: 2.8, accel: 0.12,
          cooldown: 240, initialDelay: 100,
        },
        {
          spawnX: 110 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 300, initialDelay: 260,
        },
        {
          spawnX: 5 * TILE,
          spawnY: (GROUND_ - 8) * TILE,
          speed: 2.4, accel: 0.09,
          cooldown: 360, initialDelay: 380,
        },
      ],
      reversers: { minDelay: 220, maxDelay: 360, initialDelay: 160 },
    };
  }

  function buildLevel95(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 38; c <= 40; c++) set(r, c, " ");
    for (var r2 = GROUND_; r2 < ROWS; r2++) for (var c2 = 64; c2 <= 66; c2++) set(r2, c2, " ");
    setRect(GROUND_ - 3, 14, GROUND_ - 1, 14, "S");
    set(GROUND_ - 1, 22, "X");
    setRect(GROUND_ - 3, 50, GROUND_ - 1, 50, "S");
    set(GROUND_, 58, "B");
    setRect(GROUND_ - 3, 78, GROUND_ - 1, 78, "S");
    set(GROUND_ - 1, 88, "X");
    setRect(GROUND_ - 3, 96, GROUND_ - 1, 96, "S");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 14, "C");
    set(GROUND_ - 1, 30, "C");
    set(GROUND_ - 4, 50, "C");
    set(GROUND_ - 1, 72, "C");
    set(GROUND_ - 4, 78, "C");
    set(GROUND_ - 4, 96, "C");
    set(GROUND_ - 1, 108, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 110 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.4,
          w: 36, h: 36,
          cooldown: 220,
          initialDelay: 100,
        },
        {
          spawnX: 110 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -2.6,
          w: 32, h: 32,
          cooldown: 320,
          initialDelay: 320,
        },
      ],
      missiles: [
        {
          spawnX: 110 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.8, accel: 0.12,
          cooldown: 260, initialDelay: 160,
        },
      ],
      reversers: { minDelay: 180, maxDelay: 300, initialDelay: 120 },
    };
  }

  function buildLevel96(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var c = 28; c <= 64; c++) set(GROUND_ - 1, c, "X");
    setRect(GROUND_ - 7, 26, GROUND_ - 7, 66, "G");
    setRect(GROUND_ - 8, 26, GROUND_ - 8, 66, "D");
    set(GROUND_ - 1, 26, "U");
    set(GROUND_ - 6, 64, "U");
    set(GROUND_ - 6, 38, "C");
    set(GROUND_ - 6, 50, "C");
    setRect(GROUND_ - 3, 78, GROUND_ - 1, 78, "S");
    set(GROUND_, 90, "B");
    setRect(GROUND_ - 3, 100, GROUND_ - 1, 100, "S");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 1, 16, "C");
    set(GROUND_ - 1, 72, "C");
    set(GROUND_ - 4, 78, "C");
    set(GROUND_ - 1, 86, "C");
    set(GROUND_ - 4, 100, "C");
    set(GROUND_ - 1, 110, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 110 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 280,
          initialDelay: 200,
        },
      ],
      missiles: [
        {
          spawnX: 115 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.8, accel: 0.12,
          cooldown: 240, initialDelay: 120,
        },
        {
          spawnX: 115 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 280,
        },
      ],
      reversers: { minDelay: 180, maxDelay: 300, initialDelay: 130 },
    };
  }

  function buildLevel97(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 30; c <= 50; c++) set(r, c, " ");
    set(GROUND_ - 1, 26, "P");
    set(GROUND_ - 1, 56, "P");
    setRect(GROUND_ - 3, 14, GROUND_ - 1, 14, "S");
    set(GROUND_, 22, "B");
    setRect(GROUND_ - 3, 70, GROUND_ - 1, 70, "S");
    set(GROUND_ - 1, 80, "X");
    setRect(GROUND_ - 3, 90, GROUND_ - 1, 90, "S");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 14, "C");
    set(GROUND_ - 1, 60, "C");
    set(GROUND_ - 4, 70, "C");
    set(GROUND_ - 1, 86, "C");
    set(GROUND_ - 4, 90, "C");
    set(GROUND_ - 1, 100, "C");
    set(GROUND_ - 1, 114, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 110 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 260,
          initialDelay: 160,
        },
      ],
      missiles: [
        {
          spawnX: 115 * TILE,
          spawnY: (GROUND_ - 5) * TILE,
          speed: 2.8, accel: 0.12,
          cooldown: 260, initialDelay: 140,
        },
        {
          spawnX: 115 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 280,
        },
        {
          spawnX: 5 * TILE,
          spawnY: (GROUND_ - 8) * TILE,
          speed: 2.4, accel: 0.09,
          cooldown: 360, initialDelay: 380,
        },
      ],
      reversers: { minDelay: 200, maxDelay: 340, initialDelay: 140 },
    };
  }

  function buildLevel98(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    addVineColumn(set, setRect, GROUND_, 16, 17, 24);
    setRect(GROUND_ - 3, 30, GROUND_ - 3, 34, "F");
    setRect(GROUND_ - 3, 40, GROUND_ - 3, 44, "F");
    setRect(GROUND_ - 3, 50, GROUND_ - 3, 54, "F");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 64; c <= 66; c++) set(r, c, " ");
    setRect(GROUND_ - 3, 76, GROUND_ - 1, 76, "S");
    set(GROUND_, 86, "B");
    setRect(GROUND_ - 3, 94, GROUND_ - 1, 94, "S");
    setRect(GROUND_ - 3, 110, GROUND_ - 1, 110, "S");
    set(GROUND_ - 1, 122, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 8, 20, "C");
    set(GROUND_ - 4, 32, "C");
    set(GROUND_ - 4, 42, "C");
    set(GROUND_ - 4, 52, "C");
    set(GROUND_ - 1, 60, "C");
    set(GROUND_ - 1, 72, "C");
    set(GROUND_ - 4, 76, "C");
    set(GROUND_ - 4, 94, "C");
    set(GROUND_ - 1, 102, "C");
    set(GROUND_ - 4, 110, "C");
    set(GROUND_ - 1, 118, "C");
    set(GROUND_ - 1, 130, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 130 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.0,
          w: 36, h: 36,
          cooldown: 280,
          initialDelay: 200,
        },
      ],
      missiles: [
        {
          spawnX: 135 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.8, accel: 0.12,
          cooldown: 240, initialDelay: 120,
        },
        {
          spawnX: 135 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.6, accel: 0.10,
          cooldown: 320, initialDelay: 280,
        },
      ],
      reversers: { minDelay: 180, maxDelay: 300, initialDelay: 130 },
    };
  }

  function buildLevel99(grid_, COLS_, GROUND_, set, setRect) {
    var ec = COLS_ - 1;
    setRect(GROUND_, 0, GROUND_, ec, "G");
    setRect(GROUND_ + 1, 0, ROWS - 1, ec, "D");
    setRect(GROUND_ - 3, 14, GROUND_ - 1, 14, "S");
    set(GROUND_, 22, "B");
    addVineColumn(set, setRect, GROUND_, 30, 31, 36);
    setRect(GROUND_ - 3, 40, GROUND_ - 3, 44, "F");
    setRect(GROUND_ - 3, 48, GROUND_ - 3, 52, "F");
    setRect(GROUND_ - 3, 56, GROUND_ - 3, 60, "F");
    for (var r = GROUND_; r < ROWS; r++) for (var c = 70; c <= 72; c++) set(r, c, " ");
    set(GROUND_ - 1, 80, "X");
    setRect(GROUND_ - 3, 90, GROUND_ - 1, 90, "S");
    for (var c2 = 102; c2 <= 134; c2++) set(GROUND_ - 1, c2, "X");
    setRect(GROUND_ - 7, 100, GROUND_ - 7, 136, "G");
    setRect(GROUND_ - 8, 100, GROUND_ - 8, 136, "D");
    set(GROUND_ - 1, 100, "U");
    set(GROUND_ - 6, 134, "U");
    set(GROUND_ - 6, 112, "C");
    set(GROUND_ - 6, 124, "C");
    setRect(GROUND_ - 3, 146, GROUND_ - 1, 146, "S");
    set(GROUND_ - 1, 156, "X");
    set(GROUND_ - 1, 6, "C");
    set(GROUND_ - 4, 14, "C");
    set(GROUND_ - 8, 34, "C");
    set(GROUND_ - 4, 42, "C");
    set(GROUND_ - 4, 50, "C");
    set(GROUND_ - 4, 58, "C");
    set(GROUND_ - 1, 66, "C");
    set(GROUND_ - 1, 78, "C");
    set(GROUND_ - 4, 90, "C");
    set(GROUND_ - 1, 96, "C");
    set(GROUND_ - 4, 146, "C");
    set(GROUND_ - 1, 162, "C");
    set(GROUND_ - 1, ec - 2, "E");
    return {
      spawn: { x: 50, y: (GROUND_ - 1) * TILE - 2 },
      movers: [],
      boulders: [
        {
          spawnX: 88 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -3.2,
          w: 36, h: 36,
          cooldown: 240,
          initialDelay: 180,
        },
        {
          spawnX: 88 * TILE,
          y: GROUND_ * TILE - 18,
          vx: -2.6,
          w: 32, h: 32,
          cooldown: 320,
          initialDelay: 360,
        },
      ],
      missiles: [
        {
          spawnX: 165 * TILE,
          spawnY: (GROUND_ - 6) * TILE,
          speed: 2.9, accel: 0.13,
          cooldown: 240, initialDelay: 120,
        },
        {
          spawnX: 165 * TILE,
          spawnY: (GROUND_ - 9) * TILE,
          speed: 2.7, accel: 0.11,
          cooldown: 300, initialDelay: 260,
        },
        {
          spawnX: 5 * TILE,
          spawnY: (GROUND_ - 8) * TILE,
          speed: 2.4, accel: 0.09,
          cooldown: 380, initialDelay: 420,
        },
      ],
      reversers: { minDelay: 160, maxDelay: 280, initialDelay: 140 },
    };
  }

  var LEVELS = [
    { name: "Misty Marsh", cols: 44, build: buildLevel01 },
    { name: "Thorn Canopy", cols: 48, build: buildLevel02 },
    { name: "Sunrise Trail", cols: 90, build: buildLevel00 },
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
    { name: "Storm Gate", cols: 52, build: buildLevel30 },
    { name: "Pillar Run", cols: 56, build: buildLevel31 },
    { name: "Sky Vines", cols: 60, build: buildLevel32 },
    { name: "Crumble Drift", cols: 60, build: buildLevel33 },
    { name: "Final Ascent", cols: 72, build: buildLevel34 },
    { name: "Tunnel Loop", cols: 80, build: buildLevel35 },
    { name: "Sky Shortcut", cols: 90, build: buildLevel36 },
    { name: "Long Mile", cols: 100, build: buildLevel37 },
    { name: "Bomb Bypass", cols: 90, build: buildLevel38 },
    { name: "Citadel", cols: 110, build: buildLevel39 },
    { name: "Rising Tower", cols: 70, build: buildLevel40 },
    { name: "Twin Lifts", cols: 80, build: buildLevel41 },
    { name: "Crossroads", cols: 90, build: buildLevel42 },
    { name: "Sky Vault", cols: 100, build: buildLevel43 },
    { name: "The Final Trial", cols: 120, build: buildLevel44 },
    { name: "Boulder Run", cols: 90, build: buildLevel45 },
    { name: "Twin Boulders", cols: 100, build: buildLevel46 },
    { name: "Avalanche", cols: 100, build: buildLevel47 },
    { name: "Ridge Boulder", cols: 110, build: buildLevel48 },
    { name: "Stone Storm", cols: 140, build: buildLevel49 },
    { name: "Topsy Turvy", cols: 80, build: buildLevel50 },
    { name: "Spike Floor", cols: 90, build: buildLevel51 },
    { name: "Inverted Gauntlet", cols: 100, build: buildLevel52 },
    { name: "Twin Worlds", cols: 100, build: buildLevel53 },
    { name: "Final Reversal", cols: 120, build: buildLevel54 },
    { name: "Triple Flip", cols: 90, build: buildLevel55 },
    { name: "Pit Bridge", cols: 110, build: buildLevel56 },
    { name: "Spike Skylane", cols: 110, build: buildLevel57 },
    { name: "Boulder Bypass II", cols: 110, build: buildLevel58 },
    { name: "Universe Inverted", cols: 140, build: buildLevel59 },
    { name: "Reflect Pool", cols: 100, build: buildLevel60 },
    { name: "Hanging Gauntlet", cols: 110, build: buildLevel61 },
    { name: "Twin Echo", cols: 120, build: buildLevel62 },
    { name: "Stone Mirror", cols: 130, build: buildLevel63 },
    { name: "Origin", cols: 150, build: buildLevel64 },
    { name: "Pursuit", cols: 100, build: buildLevel65 },
    { name: "Cover Run", cols: 110, build: buildLevel66 },
    { name: "Two Hunters", cols: 130, build: buildLevel67 },
    { name: "Sky Hunt", cols: 130, build: buildLevel68 },
    { name: "Final Hunt", cols: 160, build: buildLevel69 },
    { name: "Cannon Range", cols: 110, build: buildLevel70 },
    { name: "Crossfire", cols: 120, build: buildLevel71 },
    { name: "Triple Cannon", cols: 130, build: buildLevel72 },
    { name: "Sky Cannon", cols: 130, build: buildLevel73 },
    { name: "Apocalypse", cols: 160, build: buildLevel74 },
    { name: "Storm Forge", cols: 130, build: buildLevel75 },
    { name: "Mirror Hunt", cols: 140, build: buildLevel76 },
    { name: "Sky Boulders", cols: 130, build: buildLevel77 },
    { name: "Triple Trial", cols: 150, build: buildLevel78 },
    { name: "World's End", cols: 180, build: buildLevel79 },
    { name: "Twist Trail", cols: 80, build: buildLevel80 },
    { name: "Reverse Run", cols: 90, build: buildLevel81 },
    { name: "Switching Gauntlet", cols: 100, build: buildLevel82 },
    { name: "Reversal Maze", cols: 110, build: buildLevel83 },
    { name: "Final Twist", cols: 130, build: buildLevel84 },
    { name: "Tangle Trail", cols: 90, build: buildLevel85 },
    { name: "Boulder Climb", cols: 100, build: buildLevel86 },
    { name: "Twin Vines Twist", cols: 100, build: buildLevel87 },
    { name: "Reversed Heights", cols: 110, build: buildLevel88 },
    { name: "Crown of Vines", cols: 130, build: buildLevel89 },
    { name: "Lift Off", cols: 90, build: buildLevel90 },
    { name: "Cannon Lifts", cols: 100, build: buildLevel91 },
    { name: "Flip Lift", cols: 100, build: buildLevel92 },
    { name: "Crumble Sky", cols: 100, build: buildLevel93 },
    { name: "Sky Apocalypse", cols: 120, build: buildLevel94 },
    { name: "Boulder Pursuit", cols: 110, build: buildLevel95 },
    { name: "Mirror Hunt II", cols: 120, build: buildLevel96 },
    { name: "Portal Cannon", cols: 120, build: buildLevel97 },
    { name: "Infinity Run", cols: 140, build: buildLevel98 },
    { name: "The End", cols: 170, build: buildLevel99 },
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
    boulders = (out.boulders || []).map(function (b) {
      return {
        spawnX: b.spawnX,
        spawnY: b.y,
        x: b.spawnX,
        y: b.y,
        vx: b.vx,
        vy: 0,
        w: b.w || 36,
        h: b.h || 36,
        cooldown: b.cooldown || 120,
        cooldownT: b.initialDelay || 0,
        alive: false,
        rot: 0,
      };
    });
    missiles = (out.missiles || []).map(function (mm) {
      return {
        spawnX: mm.spawnX,
        spawnY: mm.spawnY,
        x: mm.spawnX,
        y: mm.spawnY,
        vx: 0,
        vy: 0,
        speed: mm.speed || 2.5,
        accel: mm.accel || 0.12,
        w: mm.w || 26,
        h: mm.h || 14,
        cooldown: mm.cooldown || 300,
        cooldownT: mm.initialDelay || 0,
        alive: false,
        rot: 0,
        firedT: 0,
      };
    });
    for (var k in crumble) delete crumble[k];
    for (var r = 0; r < ROWS; r++)
      for (var c = 0; c < COLS; c++) {
        if (grid[r][c] === "F") crumble[r + "," + c] = { state: "solid", t: 0 };
      }
    portals = [];
    for (var pr = 0; pr < ROWS; pr++)
      for (var pc = 0; pc < COLS; pc++) if (grid[pr][pc] === "P") portals.push({ r: pr, c: pc });
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
    gemHintT = 0;
    devilTimer =
      currentLevel >= DEVIL_DIFFICULTY_FROM_INDEX && currentLevel < DEVIL_DIFFICULTY_TO_INDEX
        ? 1.4 + Math.random() * 2.2
        : 0;
    reversers = [];
    if (out.reversers) {
      reverserActive = true;
      reverserSpawnMin = out.reversers.minDelay || 180;
      reverserSpawnMax = out.reversers.maxDelay || 360;
      reverserSpawnT = (out.reversers.initialDelay || 90) + Math.floor(Math.random() * 60);
    } else {
      reverserActive = false;
      reverserSpawnT = 0;
    }
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
    volatileRestores = [];
    player.portalLockIdx = -1;
    player.gravityDir = 1;
    player.gravityFlipCooldown = 0;
    for (var bi = 0; bi < boulders.length; bi++) {
      boulders[bi].alive = false;
      boulders[bi].cooldownT = 60;
    }
    for (var mi = 0; mi < missiles.length; mi++) {
      missiles[mi].alive = false;
      missiles[mi].cooldownT = 90;
    }
    reversers = [];
    if (reverserActive) reverserSpawnT = 90 + Math.floor(Math.random() * 60);
    player.controlsReverseT = 0;
  }

  function syncRunButtonVisual() {
    if (!runTouchButton) return;
    var on = !!touchRunFast;
    runTouchButton.classList.toggle("is-fast", on);
    runTouchButton.setAttribute("aria-checked", on ? "true" : "false");
  }

  function rollDevilEvent() {
    if (currentLevel < DEVIL_DIFFICULTY_FROM_INDEX || currentLevel >= DEVIL_DIFFICULTY_TO_INDEX || !player.alive || gameState !== "playing") return;
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

  function boulderTileSolid(t) {
    return t === "G" || t === "D" || t === "S" || t === "B";
  }

  function updateBoulders() {
    for (var i = 0; i < boulders.length; i++) {
      var b = boulders[i];
      if (!b.alive) {
        b.cooldownT--;
        if (b.cooldownT <= 0) {
          b.alive = true;
          b.x = b.spawnX;
          b.y = b.spawnY;
          b.vy = 0;
          b.rot = 0;
        }
        continue;
      }
      b.vy = Math.min(14, b.vy + 0.5);
      b.y += b.vy;
      var c = Math.floor(b.x / TILE);
      var bottomRow = Math.floor((b.y + b.h / 2) / TILE);
      if (b.vy >= 0 && bottomRow >= 0 && bottomRow < ROWS && c >= 0 && c < COLS) {
        var t = grid[bottomRow][c];
        if (boulderTileSolid(t)) {
          b.y = bottomRow * TILE - b.h / 2;
          b.vy = 0;
        }
      }
      b.x += b.vx;
      b.rot += b.vx * 0.06;
      if (b.x < -b.w || b.x > LEVEL_W + b.w || b.y > LEVEL_H + 80) {
        b.alive = false;
        b.cooldownT = b.cooldown;
        continue;
      }
      if (player.alive && rectOverlap(player.x + 3, player.y + 4, player.w - 6, player.h - 6, b.x - b.w / 2 + 4, b.y - b.h / 2 + 4, b.w - 8, b.h - 8)) {
        die();
      }
    }
  }

  function drawBouldersWorld() {
    for (var i = 0; i < boulders.length; i++) {
      var b = boulders[i];
      if (!b.alive) continue;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(0, b.h / 2 - 2, b.w / 2 - 2, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(b.rot);
      var grad = ctx.createRadialGradient(-b.w / 6, -b.h / 6, 2, 0, 0, b.w / 2);
      grad.addColorStop(0, "#998470");
      grad.addColorStop(0.6, "#6b5544");
      grad.addColorStop(1, "#3d2e22");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, b.w / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(20,12,6,0.55)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,235,200,0.18)";
      ctx.beginPath();
      ctx.arc(-b.w / 5, -b.h / 5, b.w / 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(20,12,6,0.5)";
      ctx.beginPath();
      ctx.arc(b.w / 6, b.h / 8, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-b.w / 8, b.h / 5, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function updateMissiles() {
    for (var i = 0; i < missiles.length; i++) {
      var m = missiles[i];
      if (m.firedT > 0) m.firedT--;
      if (player.alive) {
        var apdx = player.x + player.w / 2 - m.spawnX;
        var apdy = player.y + player.h / 2 - m.spawnY;
        var tgtAngle = Math.atan2(apdy, apdx);
        if (typeof m.aimAngle !== "number") m.aimAngle = tgtAngle;
        var adiff = tgtAngle - m.aimAngle;
        while (adiff > Math.PI) adiff -= 2 * Math.PI;
        while (adiff < -Math.PI) adiff += 2 * Math.PI;
        m.aimAngle += adiff * 0.12;
      }
      if (!m.alive) {
        m.cooldownT--;
        if (m.cooldownT <= 0) {
          m.alive = true;
          m.x = m.spawnX;
          m.y = m.spawnY;
          if (player.alive) {
            var ldx = player.x + player.w / 2 - m.x;
            var ldy = player.y + player.h / 2 - m.y;
            var ld = Math.sqrt(ldx * ldx + ldy * ldy) || 1;
            m.vx = (ldx / ld) * m.speed * 0.6;
            m.vy = (ldy / ld) * m.speed * 0.6;
            m.rot = Math.atan2(m.vy, m.vx);
            var mzx = m.spawnX + Math.cos(m.rot) * 34;
            var mzy = m.spawnY + Math.sin(m.rot) * 34;
            for (var pk = 0; pk < 14; pk++) {
              var sp = 1 + Math.random() * 2.5;
              var jit = (Math.random() - 0.5) * 0.7;
              particles.push({
                x: mzx + (Math.random() - 0.5) * 6,
                y: mzy + (Math.random() - 0.5) * 6,
                vx: Math.cos(m.rot + jit) * sp,
                vy: Math.sin(m.rot + jit) * sp,
                life: 22 + Math.random() * 22,
                color: pk < 4 ? "#fff5d0" : pk < 8 ? "#ffae42" : pk < 11 ? "#7a7a7a" : "#aaa",
                size: 2 + Math.random() * 3,
              });
            }
          } else {
            m.vx = 0;
            m.vy = 0;
            m.rot = 0;
          }
          m.firedT = 16;
        }
        continue;
      }
      if (player.alive) {
        var dx = player.x + player.w / 2 - m.x;
        var dy = player.y + player.h / 2 - m.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        m.vx += (dx / dist) * m.accel;
        m.vy += (dy / dist) * m.accel;
        var spd = Math.sqrt(m.vx * m.vx + m.vy * m.vy);
        if (spd > m.speed) {
          m.vx = (m.vx / spd) * m.speed;
          m.vy = (m.vy / spd) * m.speed;
        }
      }
      m.x += m.vx;
      m.y += m.vy;
      m.rot = Math.atan2(m.vy, m.vx);
      var col = Math.floor(m.x / TILE);
      var row = Math.floor(m.y / TILE);
      if (row >= 0 && row < ROWS && col >= 0 && col < COLS) {
        var t = grid[row][col];
        if (t === "G" || t === "D" || t === "S" || t === "B") {
          m.alive = false;
          m.cooldownT = m.cooldown;
          for (var k = 0; k < 14; k++) {
            particles.push({
              x: m.x, y: m.y,
              vx: (Math.random() - 0.5) * 6,
              vy: (Math.random() - 0.5) * 6,
              life: 28 + Math.random() * 20,
              color: ["#ff8a3a", "#ffd060", "#3a3a3a"][k % 3],
              size: 2 + Math.random() * 3,
            });
          }
          continue;
        }
      }
      if (m.x < -m.w || m.x > LEVEL_W + m.w || m.y < -m.h || m.y > LEVEL_H + m.h) {
        m.alive = false;
        m.cooldownT = m.cooldown;
        continue;
      }
      if (player.alive && rectOverlap(player.x + 3, player.y + 4, player.w - 6, player.h - 6, m.x - m.w / 2 + 2, m.y - m.h / 2 + 2, m.w - 4, m.h - 4)) {
        die();
      }
    }
  }

  function drawMissileCannons() {
    var nowT = performance.now();
    for (var i = 0; i < missiles.length; i++) {
      var m = missiles[i];
      var sx = m.spawnX, sy = m.spawnY;
      var angle = typeof m.aimAngle === "number" ? m.aimAngle : (m.alive ? m.rot : 0);
      var charging = !m.alive && m.cooldownT > 0 && m.cooldownT < 70;
      var chargeT = charging ? 1 - m.cooldownT / 70 : 0;

      // ---- Shadow + base mount ----
      ctx.save();
      ctx.translate(sx, sy);
      ctx.fillStyle = "rgba(0,0,0,0.42)";
      ctx.beginPath();
      ctx.ellipse(0, 16, 19, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      var bg = ctx.createLinearGradient(0, 0, 0, 18);
      bg.addColorStop(0, "#4a4a4a");
      bg.addColorStop(0.4, "#2a2a2a");
      bg.addColorStop(1, "#161616");
      ctx.fillStyle = bg;
      ctx.fillRect(-15, 0, 30, 18);
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 2;
      ctx.strokeRect(-15, 0, 30, 18);
      ctx.fillStyle = "#5a5a5a";
      ctx.fillRect(-13, 1, 26, 1.5);
      ctx.fillStyle = "#3a3a3a";
      ctx.fillRect(-12, 5, 24, 10);
      ctx.strokeStyle = "#0a0a0a";
      ctx.strokeRect(-12, 5, 24, 10);
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(-10, 7, 4, 6);
      ctx.fillRect(-3, 7, 6, 6);
      ctx.fillRect(6, 7, 4, 6);
      ctx.fillStyle = "rgba(80,180,80,0.7)";
      ctx.fillRect(-2, 8, 4, 1);
      ctx.fillRect(-2, 11, 4, 1);
      for (var b = -10; b <= 10; b += 5) {
        ctx.fillStyle = "#9a9a9a";
        ctx.beginPath();
        ctx.arc(b, 16, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.arc(b, 16, 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // ---- Rotating turret head ----
      var kick = m.firedT > 0 ? Math.pow(m.firedT / 16, 0.7) * 7 : 0;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      ctx.translate(-kick, 0);

      var hg = ctx.createRadialGradient(-3, -3, 1, 0, 0, 12);
      hg.addColorStop(0, "#7a7a7a");
      hg.addColorStop(0.6, "#3a3a3a");
      hg.addColorStop(1, "#1a1a1a");
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#222";
      ctx.fillRect(-9, -1.5, 7, 3);
      ctx.fillRect(2, -1.5, 7, 3);

      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-7, -9);
      ctx.lineTo(-10, -16);
      ctx.stroke();
      var antBlink = (Math.floor(nowT / 280) % 2) === 0 ? 1 : 0.4;
      ctx.fillStyle = "rgba(255," + Math.floor(60 * antBlink + 40) + "," + Math.floor(60 * antBlink + 40) + ",0.95)";
      ctx.beginPath();
      ctx.arc(-10, -16, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.beginPath();
      ctx.arc(-10.5, -16.5, 0.8, 0, Math.PI * 2);
      ctx.fill();

      var brg = ctx.createLinearGradient(0, -7, 0, 7);
      brg.addColorStop(0, "#4a4a4a");
      brg.addColorStop(0.5, "#2a2a2a");
      brg.addColorStop(1, "#1a1a1a");
      ctx.fillStyle = brg;
      ctx.fillRect(2, -7, 28, 14);
      ctx.strokeStyle = "#0a0a0a";
      ctx.strokeRect(2, -7, 28, 14);
      ctx.fillStyle = "#5a5a5a";
      ctx.fillRect(4, -6, 24, 1);
      ctx.fillStyle = "#0e0e0e";
      ctx.fillRect(7, -4, 20, 1.5);
      ctx.fillRect(7, -1, 20, 1.5);
      ctx.fillRect(7, 2, 20, 1.5);

      if (chargeT > 0) {
        var hAlpha = chargeT * chargeT;
        var heat = ctx.createLinearGradient(8, 0, 30, 0);
        heat.addColorStop(0, "rgba(255, 60, 30, " + (hAlpha * 0.45) + ")");
        heat.addColorStop(0.7, "rgba(255, 180, 60, " + (hAlpha * 0.7) + ")");
        heat.addColorStop(1, "rgba(255, 240, 200, " + (hAlpha * 0.95) + ")");
        ctx.fillStyle = heat;
        ctx.fillRect(2, -7, 28, 14);
      }

      ctx.fillStyle = "#9a9a9a";
      ctx.fillRect(28, -8, 5, 16);
      ctx.strokeRect(28, -8, 5, 16);
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(32, 0, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1a1a1a";
      ctx.beginPath();
      ctx.arc(32, 0, 1.8, 0, Math.PI * 2);
      ctx.fill();

      if (chargeT > 0.3) {
        var rt = (chargeT - 0.3) / 0.7;
        var ringR = 5 + Math.sin(nowT / 30) * 1.5 + rt * 2;
        ctx.strokeStyle = "rgba(255, 220, 100, " + rt + ")";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(32, 0, ringR, 0, Math.PI * 2);
        ctx.stroke();
        var coreA = 0.6 + Math.sin(nowT / 30) * 0.3;
        var cg = ctx.createRadialGradient(32, 0, 0, 32, 0, ringR);
        cg.addColorStop(0, "rgba(255, 255, 220, " + (rt * coreA) + ")");
        cg.addColorStop(0.6, "rgba(255, 180, 80, " + (rt * coreA * 0.6) + ")");
        cg.addColorStop(1, "rgba(255, 80, 40, 0)");
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(32, 0, ringR, 0, Math.PI * 2);
        ctx.fill();
      }

      var visorOn = m.alive || charging;
      ctx.fillStyle = visorOn ? "#cc3a3a" : "#3a8a3a";
      ctx.beginPath();
      ctx.arc(6, 0, 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (visorOn) {
        var vp = 0.4 + 0.6 * Math.sin(nowT / 70);
        ctx.fillStyle = "rgba(255, 220, 220, " + vp + ")";
        ctx.beginPath();
        ctx.arc(6, 0, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }

      if (m.firedT > 0) {
        var t = m.firedT / 16;
        var burst = 1 - t;
        var flashR = burst * 28 + 4;
        var grad = ctx.createRadialGradient(36, 0, 0, 36, 0, flashR);
        grad.addColorStop(0, "rgba(255, 255, 235, " + Math.min(1, t * 1.5) + ")");
        grad.addColorStop(0.25, "rgba(255, 220, 130, " + t + ")");
        grad.addColorStop(0.6, "rgba(255, 130, 50, " + t * 0.6 + ")");
        grad.addColorStop(1, "rgba(180, 40, 20, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(36, 0, flashR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255, 255, 255, " + Math.min(1, t * 1.8) + ")";
        ctx.beginPath();
        ctx.arc(35, 0, 4 * t + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 230, 150, " + t + ")";
        ctx.lineWidth = 1.5;
        for (var sp = 0; sp < 6; sp++) {
          var sa = sp * (Math.PI / 3) + (1 - t) * 1.4;
          var sl = flashR * (0.85 + Math.sin(sp * 1.7) * 0.25);
          ctx.beginPath();
          ctx.moveTo(36, 0);
          ctx.lineTo(36 + Math.cos(sa) * sl, Math.sin(sa) * sl);
          ctx.stroke();
        }
        ctx.strokeStyle = "rgba(180, 180, 180, " + t * 0.55 + ")";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(36, 0, burst * 22 + 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawMissilesWorld() {
    for (var i = 0; i < missiles.length; i++) {
      var m = missiles[i];
      if (!m.alive) continue;
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(m.rot);
      var flameLen = 12 + Math.sin(performance.now() / 50) * 4;
      var fg = ctx.createLinearGradient(-m.w / 2 - flameLen, 0, -m.w / 2 + 2, 0);
      fg.addColorStop(0, "rgba(255,180,60,0)");
      fg.addColorStop(0.5, "rgba(255,200,80,0.85)");
      fg.addColorStop(1, "rgba(255,240,140,0.95)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-m.w / 2 + 2, m.h / 3);
      ctx.lineTo(-m.w / 2 - flameLen, 0);
      ctx.lineTo(-m.w / 2 + 2, -m.h / 3);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#2c2c2c";
      ctx.beginPath();
      ctx.moveTo(m.w / 2, 0);
      ctx.lineTo(-m.w / 2 + 4, m.h / 2);
      ctx.lineTo(-m.w / 2, m.h / 2);
      ctx.lineTo(-m.w / 2 + 2, 0);
      ctx.lineTo(-m.w / 2, -m.h / 2);
      ctx.lineTo(-m.w / 2 + 4, -m.h / 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#cc3a3a";
      ctx.beginPath();
      ctx.arc(m.w / 4, 0, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,220,200,0.75)";
      ctx.beginPath();
      ctx.arc(m.w / 4 + 2, -1, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function spawnReverser() {
    if (!player.alive) return;
    var px = player.x + player.w / 2;
    var dirCandidates = [];
    if (player.facing > 0) dirCandidates.push(1, -1);
    else dirCandidates.push(-1, 1);
    for (var d = 0; d < dirCandidates.length; d++) {
      var dir = dirCandidates[d];
      for (var attempt = 0; attempt < 6; attempt++) {
        var distTiles = 5 + Math.floor(Math.random() * 5);
        var spawnX = px + dir * distTiles * TILE;
        var col = Math.floor(spawnX / TILE);
        if (col < 1 || col >= COLS - 1) continue;
        var groundRow = -1;
        var startR = Math.max(0, Math.floor(player.y / TILE));
        for (var r = startR; r < ROWS; r++) {
          if (tileSolid(grid[r][col], r, col)) { groundRow = r; break; }
        }
        if (groundRow < 0) continue;
        var aboveTile = grid[groundRow - 1] ? grid[groundRow - 1][col] : " ";
        if (aboveTile === "X" || aboveTile === "B" || aboveTile === "C" ||
            aboveTile === "E" || aboveTile === "P" || aboveTile === "U" ||
            aboveTile === "V") continue;
        reversers.push({
          x: col * TILE + TILE / 2,
          y: (groundRow - 1) * TILE + TILE / 2 + 4,
          alive: true,
          spawnT: 0,
          life: 600,
        });
        return;
      }
    }
  }

  function updateReversers() {
    if (reverserActive && player.alive) {
      if (reversers.length === 0) {
        reverserSpawnT--;
        if (reverserSpawnT <= 0) {
          spawnReverser();
          var range = reverserSpawnMax - reverserSpawnMin;
          reverserSpawnT = reverserSpawnMin + Math.floor(Math.random() * range);
        }
      }
    }
    for (var i = reversers.length - 1; i >= 0; i--) {
      var rv = reversers[i];
      if (!rv.alive) { reversers.splice(i, 1); continue; }
      rv.spawnT++;
      rv.life--;
      if (rv.life <= 0) { reversers.splice(i, 1); continue; }
      if (player.alive && rv.spawnT >= 6) {
        var dx = player.x + player.w / 2 - rv.x;
        var dy = player.y + player.h / 2 - rv.y;
        if (Math.abs(dx) < TILE * 0.55 && Math.abs(dy) < TILE * 0.7) {
          player.controlsReverseT = 240;
          for (var k = 0; k < 18; k++) {
            particles.push({
              x: rv.x + (Math.random() - 0.5) * 8,
              y: rv.y + (Math.random() - 0.5) * 8,
              vx: (Math.random() - 0.5) * 6,
              vy: (Math.random() - 0.5) * 6 - 1,
              life: 30 + Math.random() * 18,
              color: k < 6 ? "#ff52d6" : k < 12 ? "#a062ff" : "#ffe2ff",
              size: 2 + Math.random() * 3,
            });
          }
          reversers.splice(i, 1);
        }
      }
    }
  }

  function drawReversers() {
    var nowT = performance.now();
    for (var i = 0; i < reversers.length; i++) {
      var rv = reversers[i];
      var scale = Math.min(1, rv.spawnT / 8);
      var alpha = rv.life > 90 ? 1 : Math.max(0, rv.life / 90);
      var bob = Math.sin(nowT / 220) * 2;
      ctx.save();
      ctx.translate(rv.x, rv.y + bob);
      ctx.globalAlpha = alpha;
      var pulse = 1 + Math.sin(nowT / 140) * 0.08;
      var glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 22 * pulse);
      glow.addColorStop(0, "rgba(255,80,220,0.55)");
      glow.addColorStop(1, "rgba(80,30,100,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 22 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.scale(scale, scale);
      ctx.rotate((nowT % 1500) / 1500 * Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ff4de6";
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0.35, Math.PI - 0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 11, Math.PI + 0.35, Math.PI * 2 - 0.35);
      ctx.stroke();
      ctx.fillStyle = "#ff4de6";
      ctx.beginPath();
      ctx.moveTo(-13, 1);
      ctx.lineTo(-7, -4);
      ctx.lineTo(-7, 6);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(13, -1);
      ctx.lineTo(7, 4);
      ctx.lineTo(7, -6);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff0ff";
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fill();
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
            p.vy = 0;
            if (p.gravityDir > 0) p.onGround = true;
            if (t === "F" && p.gravityDir > 0) {
              var k = r + "," + c;
              if (crumble[k].state === "solid") crumble[k].state = "shaking";
            }
          } else if (dy < 0) {
            p.y = ty + TILE;
            p.vy = 0;
            if (p.gravityDir < 0) p.onGround = true;
            if (t === "F" && p.gravityDir < 0) {
              var k2 = r + "," + c;
              if (crumble[k2].state === "solid") crumble[k2].state = "shaking";
            }
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
          if (m.axis === "y") p.y += m.dir * m.speed;
          else p.x += m.dir * m.speed;
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
        if (t === "E" && rectOverlap(player.x, player.y, player.w, player.h, tx, ty, TILE, TILE)) {
          if (gemsCollected.size >= totalGems) win();
          else if (gemHintT <= 0) gemHintT = 150;
        }
        if (t === "U" && player.gravityFlipCooldown <= 0 && rectOverlap(player.x, player.y, player.w, player.h, tx + 4, ty + 4, TILE - 8, TILE - 8)) {
          player.gravityDir = -player.gravityDir;
          player.gravityFlipCooldown = 24;
          player.vy = 0;
          spawnSparkle(tx + TILE / 2, ty + TILE / 2);
          spawnSparkle(player.x + player.w / 2, player.y + player.h / 2);
        }
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
    if (portals.length === 2) {
      var pcx = player.x + player.w / 2;
      var pcy = player.y + player.h / 2;
      var insideIdx = -1;
      for (var pi = 0; pi < 2; pi++) {
        var p0 = portals[pi];
        var ptx = p0.c * TILE;
        var pty = p0.r * TILE;
        if (pcx >= ptx && pcx < ptx + TILE && pcy >= pty && pcy < pty + TILE) {
          insideIdx = pi;
          break;
        }
      }
      if (insideIdx === -1) {
        player.portalLockIdx = -1;
      } else if (insideIdx !== player.portalLockIdx) {
        var src = portals[insideIdx];
        var dest = portals[1 - insideIdx];
        player.x = dest.c * TILE + (TILE - player.w) / 2;
        player.y = dest.r * TILE + (TILE - player.h) / 2;
        player.portalLockIdx = 1 - insideIdx;
        spawnSparkle(player.x + player.w / 2, player.y + player.h / 2);
        spawnSparkle(src.c * TILE + TILE / 2, src.r * TILE + TILE / 2);
      }
    }
    if (gemHintT > 0) gemHintT--;
    if (player.gravityFlipCooldown > 0) player.gravityFlipCooldown--;
    if (player.y > LEVEL_H + 100 || player.y < -120) die();
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
      if (keys["ArrowLeft"] || keys["KeyA"] || touchInput.left) ax = -1;
      if (keys["ArrowRight"] || keys["KeyD"] || touchInput.right) ax = 1;
      if (player.controlsReverseT > 0) {
        ax = -ax;
        player.controlsReverseT--;
      }
      if (ax !== 0) player.facing = ax;
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
          player.vy = -JUMP * player.gravityDir;
          player.onGround = false;
          player.coyote = 0;
          player.jumpBuf = 0;
        }
        if (player.vy * player.gravityDir < -4 && !jumpHeld()) player.vy += 0.4 * player.gravityDir;
        player.vy += GRAVITY * player.gravityDir;
        if (player.gravityDir > 0) {
          if (player.vy > MAX_FALL) player.vy = MAX_FALL;
        } else {
          if (player.vy < -MAX_FALL) player.vy = -MAX_FALL;
        }
        if (!player.onGround) player.state = player.vy * player.gravityDir < 0 ? "jump" : "fall";
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
      if (mv.axis === "y") {
        mv.y += mv.dir * mv.speed;
        if (mv.y < mv.y0) { mv.y = mv.y0; mv.dir = 1; }
        if (mv.y > mv.y1) { mv.y = mv.y1; mv.dir = -1; }
      } else {
        mv.x += mv.dir * mv.speed;
        if (mv.x < mv.x0) { mv.x = mv.x0; mv.dir = 1; }
        if (mv.x > mv.x1) { mv.x = mv.x1; mv.dir = -1; }
      }
    }
    if (currentLevel >= DEVIL_DIFFICULTY_FROM_INDEX && currentLevel < DEVIL_DIFFICULTY_TO_INDEX) {
      devilTimer -= dt;
      if (devilTimer <= 0 && player.alive && gameState === "playing") {
        var pace = 5.4 + Math.random() * 3.2 - currentLevel * 0.05;
        devilTimer = Math.max(1.9, pace);
        rollDevilEvent();
      }
      updateVolatileRestores(dt);
      updateBombs(dt);
    }
    updateBoulders();
    updateMissiles();
    updateReversers();
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
  function drawSpike(x, y, inverted) {
    ctx.fillStyle = "#6e4a2a";
    if (inverted) {
      ctx.fillRect(x, y, TILE, 6);
      ctx.fillStyle = "#c0c4cc";
      for (var i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(x + i * 8, y + 6);
        ctx.lineTo(x + i * 8 + 4, y + TILE - 10);
        ctx.lineTo(x + i * 8 + 8, y + 6);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      ctx.fillRect(x, y + TILE - 6, TILE, 6);
      ctx.fillStyle = "#c0c4cc";
      for (var j = 0; j < 5; j++) {
        ctx.beginPath();
        ctx.moveTo(x + j * 8, y + TILE - 6);
        ctx.lineTo(x + j * 8 + 4, y + 10);
        ctx.lineTo(x + j * 8 + 8, y + TILE - 6);
        ctx.closePath();
        ctx.fill();
      }
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
  function drawFlipTile(x, y) {
    var cx = x + TILE / 2;
    var cy = y + TILE / 2;
    var pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
    ctx.save();
    var grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, TILE / 2);
    grad.addColorStop(0, "rgba(160, 255, 180, " + (0.5 + pulse * 0.35) + ")");
    grad.addColorStop(0.6, "rgba(70, 200, 110, 0.42)");
    grad.addColorStop(1, "rgba(20, 60, 40, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, TILE / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(20,80,40,0.85)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx, cy + 12);
    ctx.moveTo(cx - 6, cy - 6);
    ctx.lineTo(cx, cy - 12);
    ctx.lineTo(cx + 6, cy - 6);
    ctx.moveTo(cx - 6, cy + 6);
    ctx.lineTo(cx, cy + 12);
    ctx.lineTo(cx + 6, cy + 6);
    ctx.stroke();
    ctx.restore();
  }
  function drawPortal(x, y) {
    var cx = x + TILE / 2;
    var cy = y + TILE / 2;
    var t = performance.now() / 380;
    ctx.save();
    var grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, TILE / 2);
    grad.addColorStop(0, "rgba(245,220,255,0.95)");
    grad.addColorStop(0.5, "rgba(155,108,255,0.55)");
    grad.addColorStop(1, "rgba(48,12,96,0.0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, TILE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(cx, cy);
    ctx.rotate(t);
    ctx.lineWidth = 2;
    for (var i = 0; i < 3; i++) {
      ctx.strokeStyle = ["#d6b8ff", "#9b6cff", "#6f33d9"][i];
      ctx.beginPath();
      var rad = TILE / 2 - 4 - i * 4;
      ctx.arc(0, 0, rad, i * 1.1, i * 1.1 + Math.PI * 1.3);
      ctx.stroke();
    }
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
            var spikeAbove = r > 0 ? grid[r - 1][c] : " ";
            var spikeInverted = spikeAbove === "G" || spikeAbove === "D" || spikeAbove === "S";
            drawSpike(x, y, spikeInverted);
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
          case "P":
            drawPortal(x, y);
            break;
          case "U":
            drawFlipTile(x, y);
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
    if (p.alive && p.controlsReverseT > 0) {
      var nowR = performance.now();
      ctx.save();
      ctx.translate(cx, p.y - 12);
      var rotR = (nowR % 900) / 900 * Math.PI * 2;
      ctx.rotate(rotR);
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#ff4de6";
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0.35, Math.PI - 0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 7, Math.PI + 0.35, Math.PI * 2 - 0.35);
      ctx.stroke();
      ctx.fillStyle = "#ff4de6";
      ctx.beginPath();
      ctx.moveTo(-9, 0); ctx.lineTo(-5, -3); ctx.lineTo(-5, 3); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(9, 0); ctx.lineTo(5, 3); ctx.lineTo(5, -3); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(p.facing, p.gravityDir);
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
    drawBouldersWorld();
    drawMissileCannons();
    drawMissilesWorld();
    drawReversers();
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
    if (gemHintT > 0) drawGemHint();
  }

  function drawGemHint() {
    var alpha = Math.min(1, gemHintT / 30);
    var text = "Collect all gems first  " + gemsCollected.size + " / " + totalGems;
    ctx.save();
    ctx.font = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var tw = ctx.measureText(text).width;
    var bx = W / 2 - tw / 2 - 22;
    var by = 64;
    var bw = tw + 44;
    var bh = 44;
    ctx.fillStyle = "rgba(20, 12, 6, " + 0.78 * alpha + ")";
    ctx.beginPath();
    ctx.moveTo(bx + 12, by);
    ctx.lineTo(bx + bw - 12, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + 12);
    ctx.lineTo(bx + bw, by + bh - 12);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - 12, by + bh);
    ctx.lineTo(bx + 12, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - 12);
    ctx.lineTo(bx, by + 12);
    ctx.quadraticCurveTo(bx, by, bx + 12, by);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 235, 130, " + alpha + ")";
    ctx.fillText(text, W / 2, by + bh / 2 + 1);
    ctx.restore();
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
