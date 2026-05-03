/**
 * World metadata + stage names (gameplay levels live in game.js).
 */
(function (global) {
  var LEVEL_NAMES = [
    "Sunrise Trail",
    "Misty Marsh",
    "Thorn Canopy",
    "Broken Planks",
    "Log Ferry",
    "Twin Vines",
    "Sky Crumble",
    "Stone Steps",
    "Triple Crossing",
    "Temple Run",
    "Bamboo Chute",
    "Sunken Hollow",
    "Root Maze",
    "Creek Dash",
    "Ridge Hoppers",
    "Canopy Clash",
    "Mudslide",
    "Ghost Slope",
    "Long Leap",
    "Heart of Jungle",
    "Tiger Gauntlet",
    "Flooded Gully",
    "Bait Line",
    "Cinder Bridge",
    "Echo Caves",
    "Windmire Pass",
    "Shattered Walk",
    "Twin Scarps",
    "Last Clearing",
    "Skybreaker",
  ];

  var WORLDS = [
    {
      id: 1,
      title: "World 1",
      subtitle: "Deep Jungle",
      levelFrom: 1,
      levelTo: 10,
    },
    {
      id: 2,
      title: "World 2",
      subtitle: "Mist Hollow",
      levelFrom: 11,
      levelTo: 20,
    },
    {
      id: 3,
      title: "World 3",
      subtitle: "High Ruins",
      levelFrom: 21,
      levelTo: 30,
    },
  ];

  global.JungleWorld = {
    LEVEL_COUNT: LEVEL_NAMES.length,
    LEVEL_NAMES: LEVEL_NAMES,
    WORLDS: WORLDS,
    /** 1-based level number shown in UI for index i */
    levelNumber: function (index) {
      return index + 1;
    },
    getWorldForLevelIndex: function (index) {
      var n = index + 1;
      for (var w = 0; w < WORLDS.length; w++) {
        var o = WORLDS[w];
        if (n >= o.levelFrom && n <= o.levelTo) return o;
      }
      return WORLDS[WORLDS.length - 1] || WORLDS[0];
    },
  };
})(typeof window !== "undefined" ? window : this);
