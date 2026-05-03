(function () {
  var World = window.JungleWorld;
  var store = window.JungleStorage;
  var Game = window.JungleGame;
  if (!World || !store || !Game) return;

  var LEVEL_COUNT = World.LEVEL_COUNT;
  var LEVEL_NAMES = World.LEVEL_NAMES || [];
  var WORLDS = World.WORLDS || [{ id: 1, title: "World 1", subtitle: "", levelFrom: 1, levelTo: LEVEL_COUNT }];

  var appEl = document.getElementById("app");
  var screenMenu = document.getElementById("screenMenu");
  var screenWorld = document.getElementById("screenWorld");
  var screenLevel = document.getElementById("screenLevel");
  var worldTitle = document.getElementById("worldTitle");
  var worldSubtitle = document.getElementById("worldSubtitle");
  var wsCoinText = document.getElementById("wsCoinText");
  var wsSvg = document.getElementById("wsSvg");
  var wsPrev = document.getElementById("wsPrev");
  var wsNext = document.getElementById("wsNext");
  var wsPlay = document.getElementById("wsPlay");
  var statCompleted = document.getElementById("statCompleted");
  var statTotal = document.getElementById("statTotal");

  var SVG_NS = "http://www.w3.org/2000/svg";
  var ROMAN = ["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","XV"];
  var ZIGZAG_POSITIONS = [
    { x:  90, y:  90 }, { x: 220, y:  90 }, { x: 350, y:  90 }, { x: 480, y:  90 }, { x: 610, y:  90 },
    { x: 700, y: 155 },
    { x: 610, y: 220 }, { x: 480, y: 220 }, { x: 350, y: 220 }, { x: 220, y: 220 }
  ];
  var currentWorldIdx = 0;

  var popupSettings = document.getElementById("popupSettings");
  var popupPause = document.getElementById("popupPause");
  var popupGameEnd = document.getElementById("popupGameEnd");
  var gameEndTitle = document.getElementById("gameEndTitle");
  var gameEndText = document.getElementById("gameEndText");
  var gameEndActions = document.getElementById("gameEndActions");

  var settingSound = document.getElementById("settingSound");
  var settingMusic = document.getElementById("settingMusic");

  var touchLayer = document.getElementById("touchLayer");
  var touchToggle = document.getElementById("touchToggle");

  var playingLevelIndex = 0;
  var lastWorldPickMs = 0;

  /** Lifts the canvas world (ground + parallax) so the bottom control strip covers less gameplay. */
  function syncGameViewportLift() {
    if (!Game || typeof Game.setViewportLiftPx !== "function") return;
    var stage = document.querySelector(".level-game-stage");
    if (!stage) {
      Game.setViewportLiftPx(56);
      return;
    }
    var coarse = window.matchMedia && matchMedia("(pointer: coarse)").matches;
    var forced = document.body.classList.contains("touch-ui-force");
    var th = touchLayer ? touchLayer.offsetHeight : 148;
    var sh = Math.max(stage.clientHeight || 400, 280);
    var lift = 36;
    if (coarse || forced) {
      lift = Math.min(112, Math.max(52, Math.round((th / sh) * 540 * 0.78)));
    }
    Game.setViewportLiftPx(lift);
  }

  function showScreen(name) {
    [screenMenu, screenWorld, screenLevel].forEach(function (el) {
      el.classList.remove("is-active");
      el.setAttribute("aria-hidden", "true");
    });
    var el =
      name === "menu"
        ? screenMenu
        : name === "world"
          ? screenWorld
          : name === "level"
            ? screenLevel
            : screenMenu;
    el.classList.add("is-active");
    el.setAttribute("aria-hidden", "false");
    if (name === "level") appEl.classList.add("app--game");
    else appEl.classList.remove("app--game");
  }

  function openPopup(which) {
    if (which === "settings") {
      popupSettings.classList.add("is-open");
      popupSettings.setAttribute("aria-hidden", "false");
      settingSound.checked = store.getSound();
      settingMusic.checked = store.getMusic();
    } else if (which === "pause") {
      popupPause.classList.add("is-open");
      popupPause.setAttribute("aria-hidden", "false");
    }
  }

  function closePopup(which) {
    if (which === "settings" || which === "all") {
      popupSettings.classList.remove("is-open");
      popupSettings.setAttribute("aria-hidden", "true");
    }
    if (which === "pause" || which === "all") {
      popupPause.classList.remove("is-open");
      popupPause.setAttribute("aria-hidden", "true");
    }
    if (which === "gameEnd" || which === "all") {
      popupGameEnd.classList.remove("is-open");
      popupGameEnd.setAttribute("aria-hidden", "true");
    }
  }

  function syncSettingsFromUi() {
    store.setSound(settingSound.checked);
    store.setMusic(settingMusic.checked);
  }

  function maxUnlocked() {
    return store.getMaxUnlocked(LEVEL_COUNT);
  }

  function findWorldIndexForLevel(levelIdx) {
    var n = levelIdx + 1;
    for (var i = 0; i < WORLDS.length; i++) {
      var w = WORLDS[i];
      if (n >= w.levelFrom && n <= w.levelTo) return i;
    }
    return 0;
  }

  function updateMenuStats() {
    var done = Math.max(0, maxUnlocked() - 1);
    if (statCompleted) statCompleted.textContent = String(done);
    if (statTotal) statTotal.textContent = String(LEVEL_COUNT);
  }

  function nodePositionsFor(levelCount) {
    if (levelCount <= 1) return [{ x: 400, y: 155 }];
    if (levelCount >= ZIGZAG_POSITIONS.length) return ZIGZAG_POSITIONS.slice(0, levelCount);
    var result = [];
    var yLine = 155;
    var totalW = 540;
    var step = totalW / (levelCount - 1);
    var startX = (800 - totalW) / 2;
    for (var i = 0; i < levelCount; i++) result.push({ x: startX + i * step, y: yLine });
    return result;
  }

  function renderWorldMap() {
    if (!wsSvg) return;
    if (currentWorldIdx < 0) currentWorldIdx = 0;
    if (currentWorldIdx > WORLDS.length - 1) currentWorldIdx = WORLDS.length - 1;
    var w = WORLDS[currentWorldIdx];
    var unlocked = maxUnlocked();

    if (worldTitle) worldTitle.textContent = (w.title || "World " + (currentWorldIdx + 1)).toUpperCase();
    if (worldSubtitle) worldSubtitle.textContent = (w.subtitle || "").toUpperCase();
    if (wsCoinText) {
      var rn = ROMAN[currentWorldIdx] || String(currentWorldIdx + 1);
      wsCoinText.innerHTML = "WORLD<br><b>" + rn + "</b>";
    }

    while (wsSvg.firstChild) wsSvg.removeChild(wsSvg.firstChild);

    var plat = document.createElementNS(SVG_NS, "path");
    plat.setAttribute(
      "d",
      "M 50 50 L 720 50 Q 760 50, 760 90 L 760 230 Q 760 270, 720 270 " +
      "L 50 270 Q 10 270, 10 230 L 10 90 Q 10 50, 50 50 Z"
    );
    plat.setAttribute("class", "ws-platform");
    wsSvg.appendChild(plat);

    for (var tx = 30; tx < 760; tx += 26) {
      var tuft = document.createElementNS(SVG_NS, "path");
      tuft.setAttribute("d", "M " + tx + " 50 q 4 -8 8 0 q 4 -10 8 0");
      tuft.setAttribute("class", "ws-grass");
      wsSvg.appendChild(tuft);
    }
    var dirt = document.createElementNS(SVG_NS, "path");
    dirt.setAttribute(
      "d",
      "M 10 230 L 760 230 Q 760 270, 720 270 L 50 270 Q 10 270, 10 230 Z"
    );
    dirt.setAttribute("class", "ws-dirt");
    wsSvg.appendChild(dirt);

    var levelFromIdx = w.levelFrom - 1;
    var levelToIdx = w.levelTo - 1;
    var levelCount = levelToIdx - levelFromIdx + 1;
    var positions = nodePositionsFor(levelCount);

    var pathD = "";
    for (var i = 0; i < positions.length - 1; i++) {
      var p = positions[i], q = positions[i + 1];
      pathD += "M " + p.x + " " + p.y + " L " + q.x + " " + q.y + " ";
    }
    if (pathD) {
      var pathEl = document.createElementNS(SVG_NS, "path");
      pathEl.setAttribute("d", pathD);
      pathEl.setAttribute("class", "ws-path");
      wsSvg.appendChild(pathEl);
    }

    positions.forEach(function (pos, idx) {
      var globalIdx = levelFromIdx + idx;
      var isUnlocked = globalIdx < unlocked;
      var isCurrent = globalIdx === unlocked - 1;
      var levelNum = globalIdx + 1;
      var g = document.createElementNS(SVG_NS, "g");
      var classes = ["ws-node", isUnlocked ? "unlocked" : "locked"];
      if (isUnlocked && isCurrent) classes.push("is-current");
      g.setAttribute("class", classes.join(" "));
      g.setAttribute("transform", "translate(" + pos.x + ", " + pos.y + ")");
      g.setAttribute("data-level-index", String(globalIdx));
      g.setAttribute("role", "button");
      g.setAttribute("aria-label", "Level " + levelNum + (isUnlocked ? "" : " locked"));

      var circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("r", 22);
      circle.setAttribute("class", "node-circle");
      g.appendChild(circle);

      var text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.setAttribute("class", "node-text");
      text.textContent = isUnlocked ? String(levelNum) : "🔒";
      g.appendChild(text);

      wsSvg.appendChild(g);
    });

    if (wsPrev) wsPrev.disabled = currentWorldIdx === 0;
    if (wsNext) wsNext.disabled = currentWorldIdx === WORLDS.length - 1;
  }

  function handleWorldLevelInput(e) {
    if (e.pointerType === "mouse" && typeof e.button === "number" && e.button !== 0) return;
    var raw = e.target;
    if (!raw || !raw.closest) return;
    var node = raw.closest(".ws-node");
    if (!node || !node.classList.contains("unlocked")) return;
    var now = Date.now();
    if (now - lastWorldPickMs < 320) return;
    lastWorldPickMs = now;
    var ix = parseInt(node.getAttribute("data-level-index"), 10);
    if (isNaN(ix) || ix < 0 || ix >= LEVEL_COUNT) return;
    playingLevelIndex = ix;
    enterLevelScreen();
  }

  function refreshWorldSelect() {
    renderWorldMap();
  }

  function leaveLevelToWorld() {
    Game.unmount();
    Game.setPaused(false);
    closePopup("all");
    showScreen("world");
    refreshWorldSelect();
  }

  function leaveLevelToMenu() {
    Game.unmount();
    Game.setPaused(false);
    closePopup("all");
    updateMenuStats();
    showScreen("menu");
  }

  function showGameEnd(title, html, buttons) {
    gameEndTitle.textContent = title;
    gameEndText.innerHTML = html;
    gameEndActions.innerHTML = "";
    Game.setPaused(true);
    buttons.forEach(function (b) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-block " + (b.primary ? "btn-primary" : b.secondary ? "btn-secondary" : "btn-ghost");
      btn.textContent = b.label;
      btn.addEventListener("click", b.onClick);
      gameEndActions.appendChild(btn);
    });
    popupGameEnd.classList.add("is-open");
    popupGameEnd.setAttribute("aria-hidden", "false");
  }

  function mountGame() {
    var gameCanvas = document.getElementById("game");
    Game.mount({
      canvas: gameCanvas,
      levelIndex: playingLevelIndex,
      levelBadge: document.getElementById("gameLevelBadge"),
      lives: document.getElementById("gameLives"),
      time: document.getElementById("gameTime"),
      gems: document.getElementById("gameGems"),
      gemsMaxLabel: document.getElementById("gameGemsMax"),
      mapBtn: document.getElementById("btnGameLevels"),
      touchLayer: touchLayer,
      touchToggle: touchToggle,
      onRequestMap: function () {
        leaveLevelToWorld();
      },
      onTouchUiChanged: syncGameViewportLift,
      onWin: function (d) {
        store.bumpAfterClear(d.levelIndex, LEVEL_COUNT);
        closePopup("pause");
        var gems = d.gems + "/" + d.gemsMax;
        if (d.isFinal) {
          showGameEnd(
            "You conquered the jungle!",
            "Final stage cleared in <b>" +
              d.time.toFixed(1) +
              "s</b><br>Gems: <b>" +
              gems +
              "</b> · Lives: <b>" +
              d.lives +
              "</b>",
            [
              {
                label: "Play again",
                primary: true,
                onClick: function () {
                  closePopup("gameEnd");
                  playingLevelIndex = 0;
                  Game.resumeAfterOverlay("restartCampaign");
                  Game.setPaused(false);
                  refreshWorldSelect();
                },
              },
              {
                label: "Choose level",
                secondary: true,
                onClick: function () {
                  closePopup("gameEnd");
                  leaveLevelToWorld();
                  refreshWorldSelect();
                },
              },
              {
                label: "Main menu",
                onClick: function () {
                  closePopup("gameEnd");
                  leaveLevelToMenu();
                },
              },
            ]
          );
        } else {
          showGameEnd(
            "Stage cleared!",
            "Level <b>" +
              (d.levelIndex + 1) +
              "</b> done in <b>" +
              d.time.toFixed(1) +
              "s</b><br>Gems: <b>" +
              gems +
              "</b>",
            [
              {
                label: "Next level",
                primary: true,
                onClick: function () {
                  closePopup("gameEnd");
                  playingLevelIndex = d.levelIndex + 1;
                  Game.resumeAfterOverlay("next");
                  Game.setPaused(false);
                  refreshWorldSelect();
                },
              },
              {
                label: "Choose level",
                secondary: true,
                onClick: function () {
                  closePopup("gameEnd");
                  leaveLevelToWorld();
                  refreshWorldSelect();
                },
              },
              {
                label: "Main menu",
                onClick: function () {
                  closePopup("gameEnd");
                  leaveLevelToMenu();
                },
              },
            ]
          );
        }
      },
      onLose: function (d) {
        var gems = d.gems + "/" + d.gemsMax;
        showGameEnd(
          "Out of lives",
          "Gems this run: <b>" + gems + "</b>",
          [
            {
              label: "Try again",
              primary: true,
              onClick: function () {
                closePopup("gameEnd");
                Game.resumeAfterOverlay("retry");
                Game.setPaused(false);
              },
            },
            {
              label: "Choose level",
              secondary: true,
              onClick: function () {
                closePopup("gameEnd");
                leaveLevelToWorld();
              },
            },
            {
              label: "Main menu",
              onClick: function () {
                closePopup("gameEnd");
                leaveLevelToMenu();
              },
            },
          ]
        );
      },
    });
    syncGameViewportLift();
    requestAnimationFrame(syncGameViewportLift);
  }

  function enterLevelScreen() {
    showScreen("level");
    try {
      mountGame();
    } catch (err) {
      if (typeof console !== "undefined" && console.error) console.error("JungleGame.mount failed", err);
      showScreen("world");
      refreshWorldSelect();
    }
  }

  function nextUnlockedLevel() {
    return Math.max(0, Math.min(LEVEL_COUNT - 1, maxUnlocked() - 1));
  }

  document.getElementById("btnPlay").addEventListener("click", function () {
    currentWorldIdx = findWorldIndexForLevel(nextUnlockedLevel());
    showScreen("world");
    refreshWorldSelect();
  });

  var btnQuickPlay = document.getElementById("btnQuickPlay");
  if (btnQuickPlay) {
    btnQuickPlay.addEventListener("click", function () {
      playingLevelIndex = nextUnlockedLevel();
      enterLevelScreen();
    });
  }

  if (wsPlay) {
    wsPlay.addEventListener("click", function () {
      var w = WORLDS[currentWorldIdx];
      var startIdx = w ? w.levelFrom - 1 : 0;
      var endIdx = w ? w.levelTo - 1 : LEVEL_COUNT - 1;
      var unlocked = maxUnlocked();
      var pick = startIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        if (i < unlocked) { pick = i; if (i === unlocked - 1) break; }
      }
      playingLevelIndex = pick;
      enterLevelScreen();
    });
  }

  if (wsPrev) {
    wsPrev.addEventListener("click", function () {
      if (currentWorldIdx > 0) { currentWorldIdx--; renderWorldMap(); }
    });
  }
  if (wsNext) {
    wsNext.addEventListener("click", function () {
      if (currentWorldIdx < WORLDS.length - 1) { currentWorldIdx++; renderWorldMap(); }
    });
  }

  document.getElementById("btnWorldBack").addEventListener("click", function () {
    showScreen("menu");
    updateMenuStats();
  });

  document.getElementById("btnMenuSettings").addEventListener("click", function () {
    openPopup("settings");
  });

  document.getElementById("btnWorldSettings").addEventListener("click", function () {
    openPopup("settings");
  });

  popupSettings.querySelectorAll("[data-close]").forEach(function (el) {
    el.addEventListener("click", function () {
      syncSettingsFromUi();
      closePopup("settings");
    });
  });

  settingSound.addEventListener("change", syncSettingsFromUi);
  settingMusic.addEventListener("change", syncSettingsFromUi);

  document.getElementById("btnPause").addEventListener("click", function () {
    Game.setPaused(true);
    openPopup("pause");
  });

  document.getElementById("btnResume").addEventListener("click", function () {
    closePopup("pause");
    Game.setPaused(false);
  });

  document.getElementById("btnPauseLevels").addEventListener("click", function () {
    closePopup("pause");
    leaveLevelToWorld();
  });

  document.getElementById("btnPauseMenu").addEventListener("click", function () {
    closePopup("pause");
    leaveLevelToMenu();
  });

  var pauseBackdrop = popupPause.querySelector(".popup-backdrop");
  if (pauseBackdrop) {
    pauseBackdrop.addEventListener("click", function () {
      closePopup("pause");
      Game.setPaused(false);
    });
  }

  if (wsSvg) {
    wsSvg.addEventListener("click", handleWorldLevelInput, false);
    wsSvg.addEventListener("pointerup", handleWorldLevelInput, false);
  }

  window.addEventListener(
    "resize",
    function () {
      if (screenLevel && screenLevel.classList.contains("is-active")) syncGameViewportLift();
    },
    false
  );

  currentWorldIdx = findWorldIndexForLevel(nextUnlockedLevel());
  renderWorldMap();
  updateMenuStats();
  showScreen("menu");
})();
