(function (global) {
  var PREFIX = "jungle-adventure-";

  function get(key, defaultValue) {
    try {
      var v = localStorage.getItem(PREFIX + key);
      if (v === null || v === "") return defaultValue;
      return v;
    } catch (_) {
      return defaultValue;
    }
  }

  function set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, String(value));
    } catch (_) {}
  }

  function getMaxUnlocked(totalLevels) {
    var n = parseInt(get("max-unlocked", "1"), 10);
    if (isNaN(n) || n < 1) n = 1;
    if (n > totalLevels) n = totalLevels;
    return n;
  }

  function setMaxUnlocked(n, totalLevels) {
    var v = Math.max(1, Math.min(totalLevels, parseInt(n, 10) || 1));
    set("max-unlocked", v);
    return v;
  }

  function bumpAfterClear(clearedIndex, totalLevels) {
    var next = Math.max(getMaxUnlocked(totalLevels), clearedIndex + 2);
    return setMaxUnlocked(next, totalLevels);
  }

  function getSound() {
    return get("sound", "1") !== "0";
  }

  function setSound(on) {
    set("sound", on ? "1" : "0");
  }

  function getMusic() {
    return get("music", "1") !== "0";
  }

  function setMusic(on) {
    set("music", on ? "1" : "0");
  }

  global.JungleStorage = {
    getMaxUnlocked: getMaxUnlocked,
    setMaxUnlocked: setMaxUnlocked,
    bumpAfterClear: bumpAfterClear,
    getSound: getSound,
    setSound: setSound,
    getMusic: getMusic,
    setMusic: setMusic,
  };
})(typeof window !== "undefined" ? window : this);
