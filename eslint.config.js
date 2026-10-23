// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    rules: {
      // On web, react-native-web derives the window size from
      // visualViewport.width/height * scale, which drifts from the real
      // layout viewport after a pinch-zoom and never corrects. The tab bar
      // stretched edge-to-edge because of it (PR #52), and two more
      // components carried the same exposure until they were moved off it.
      // Size with flex, or measure the container with onLayout.
      "no-restricted-imports": ["error", {
        paths: [{
          name: "react-native",
          importNames: ["useWindowDimensions", "Dimensions"],
          message: "Size with flex, or measure the real box with onLayout. See running-app/CLAUDE.md (page zoom).",
        }],
      }],
    },
  },
]);
