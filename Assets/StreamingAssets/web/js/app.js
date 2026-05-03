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
  var worldGrid = document.getElementById("worldGrid");
  var worldTitle = document.getElementById("worldTitle");
  var worldSubtitle = document.getElementById("worldSubtitle");
  var worldRangeLabel = document.getElementById("worldRangeLabel");

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

  function applyWorldHeader() {
    if (worldTitle) worldTitle.textContent = "Stages";
    if (worldSubtitle) {
      var parts = [];
      for (var wi = 0; wi < WORLDS.length; wi++) {
        var o = WORLDS[wi];
        parts.push((o.title || "World") + ": " + (o.subtitle || ""));
      }
      worldSubtitle.textContent = parts.join(" · ");
    }
    if (worldRangeLabel)
      worldRangeLabel.textContent = "Levels 1–" + LEVEL_COUNT + " · " + LEVEL_COUNT + " stages";
  }

  function buildWorldGrid() {
    if (!worldGrid) return;
    worldGrid.innerHTML = "";
    applyWorldHeader();
    var unlocked = maxUnlocked();
    for (var i = 0; i < LEVEL_COUNT; i++) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "world-level-btn";
      btn.setAttribute("role", "listitem");
      btn.setAttribute("data-level-index", String(i));
      var num = World.levelNumber ? World.levelNumber(i) : i + 1;
      var nEl = document.createElement("span");
      nEl.className = "wl-num";
      nEl.textContent = String(num);
      var nameEl = document.createElement("span");
      nameEl.className = "wl-name";
      var wMeta = World.getWorldForLevelIndex ? World.getWorldForLevelIndex(i) : null;
      var wShort = wMeta && wMeta.id === 2 ? "W2" : "W1";
      nameEl.textContent = (LEVEL_NAMES[i] || "Stage " + num) + " · " + wShort;
      btn.appendChild(nEl);
      btn.appendChild(nameEl);
      var isUnlocked = i < unlocked;
      var isCurrent = i === unlocked - 1;
      if (isUnlocked) btn.classList.add("is-unlocked");
      else btn.classList.add("is-locked");
      if (isUnlocked && isCurrent) btn.classList.add("is-current");
      btn.disabled = !isUnlocked;
      btn.setAttribute("aria-label", "Level " + num + (isUnlocked ? "" : " locked"));
      worldGrid.appendChild(btn);
    }
  }

  /** Delegated pick: taps often land on inner spans; Unity WebView may omit click after touch. */
  function handleWorldLevelInput(e) {
    if (!worldGrid) return;
    if (e.pointerType === "mouse" && typeof e.button === "number" && e.button !== 0) return;
    var raw = e.target;
    if (!raw || !raw.closest) return;
    var btn = raw.closest(".world-level-btn");
    if (!btn || btn.disabled || btn.classList.contains("is-locked")) return;
    if (!worldGrid.contains(btn)) return;
    var now = Date.now();
    if (now - lastWorldPickMs < 320) return;
    lastWorldPickMs = now;
    var ix = parseInt(btn.getAttribute("data-level-index"), 10);
    if (isNaN(ix) || ix < 0 || ix >= LEVEL_COUNT) return;
    playingLevelIndex = ix;
    enterLevelScreen();
  }

  function refreshWorldSelect() {
    buildWorldGrid();
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

  document.getElementById("btnPlay").addEventListener("click", function () {
    showScreen("world");
    refreshWorldSelect();
  });

  document.getElementById("btnWorldBack").addEventListener("click", function () {
    showScreen("menu");
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

  if (worldGrid) {
    worldGrid.addEventListener("click", handleWorldLevelInput, false);
    worldGrid.addEventListener("pointerup", handleWorldLevelInput, false);
  }

  window.addEventListener(
    "resize",
    function () {
      if (screenLevel && screenLevel.classList.contains("is-active")) syncGameViewportLift();
    },
    false
  );

  buildWorldGrid();
  showScreen("menu");
})();
